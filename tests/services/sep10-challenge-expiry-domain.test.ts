import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, Networks, Transaction, WebAuth } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const store = new Map<string, number>();
  const executeRaw = vi.fn(async (sql: { strings: string[]; values: unknown[] }) => {
    const text = sql.strings.join("?");
    if (text.includes("INSERT INTO")) {
      const [id, expiresAt] = sql.values as [string, Date];
      if (store.has(id)) return 0;
      store.set(id, expiresAt.getTime());
      return 1;
    }
    if (text.includes("DELETE FROM")) {
      const now = Date.now();
      let deleted = 0;
      for (const [key, expiresAt] of store) {
        if (expiresAt <= now) {
          store.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    }
    return 0;
  });
  return { store, executeRaw };
});

vi.mock("../../src/db", () => ({
  prisma: { $executeRaw: h.executeRaw },
}));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: false,
        sequence: "0",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

import {
  buildChallenge,
  verifyChallenge,
  validateChallengeTimeBounds,
  serverKeypair,
  CHALLENGE_VALIDITY_SECONDS,
} from "../../src/services/sep10";
import { config } from "../../src/config";
import { CLOCK_SKEW_TOLERANCE_SECONDS, type TimeBounds } from "../../src/lib/time-bounds";

function signAndEncode(client: Keypair, transaction: string): string {
  const tx = new Transaction(transaction, config.networkPassphrase);
  tx.sign(client);
  return tx.toXDR();
}

function validExchange(): { client: Keypair; signedXdr: string } {
  const client = Keypair.random();
  const { transaction } = buildChallenge(client.publicKey());
  return { client, signedXdr: signAndEncode(client, transaction) };
}

describe("SEP-10 Challenge Validation & Expiration Checks (#869)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.store.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("validateChallengeTimeBounds unit checks", () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);

    it("rejects null, zero, or inverted time bounds as INVALID_CHALLENGE", () => {
      expect(() => validateChallengeTimeBounds(null, now)).toThrow();
      expect(() => validateChallengeTimeBounds({ minTime: 0, maxTime: 0 }, now)).toThrow();
      expect(() =>
        validateChallengeTimeBounds({ minTime: nowSec + 100, maxTime: nowSec + 50 }, now)
      ).toThrow();
    });

    it("rejects expired challenge bounds with 401 CHALLENGE_EXPIRED", () => {
      const expiredBounds: TimeBounds = {
        minTime: nowSec - 600,
        maxTime: nowSec - CLOCK_SKEW_TOLERANCE_SECONDS - 5,
      };

      try {
        validateChallengeTimeBounds(expiredBounds, now, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err.statusCode || err.status).toBe(401);
        expect(err.code).toBe("CHALLENGE_EXPIRED");
      }
    });

    it("rejects not-yet-valid challenge bounds with 401 CHALLENGE_NOT_YET_VALID", () => {
      const futureBounds: TimeBounds = {
        minTime: nowSec + CLOCK_SKEW_TOLERANCE_SECONDS + 10,
        maxTime: nowSec + CLOCK_SKEW_TOLERANCE_SECONDS + 300,
      };

      try {
        validateChallengeTimeBounds(futureBounds, now);
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err.statusCode || err.status).toBe(401);
        expect(err.code).toBe("CHALLENGE_NOT_YET_VALID");
      }
    });

    it("rejects excessive validity window with 401 CHALLENGE_WINDOW_TOO_LONG", () => {
      const longBounds: TimeBounds = {
        minTime: nowSec,
        maxTime: nowSec + CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 60,
      };

      try {
        validateChallengeTimeBounds(longBounds, now);
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err.statusCode || err.status).toBe(401);
        expect(err.code).toBe("CHALLENGE_WINDOW_TOO_LONG");
      }
    });

    it("accepts valid bounds within window and skew allowance", () => {
      const validBounds: TimeBounds = {
        minTime: nowSec - 10,
        maxTime: nowSec + CHALLENGE_VALIDITY_SECONDS,
      };

      expect(() => validateChallengeTimeBounds(validBounds, now)).not.toThrow();
    });
  });

  describe("verifyChallenge end-to-end verification", () => {
    it("successfully verifies a valid signed challenge transaction", async () => {
      const { client, signedXdr } = validExchange();
      const verified = await verifyChallenge(signedXdr);
      expect(verified).toBe(client.publicKey());
    });

    it("rejects when signed by an incorrect signer key with 401 INVALID_SIGNATURE", async () => {
      const client = Keypair.random();
      const attacker = Keypair.random();
      const { transaction } = buildChallenge(client.publicKey());
      // Attacker signs client's challenge
      const signedXdr = signAndEncode(attacker, transaction);

      await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({
        status: 401,
        code: "INVALID_SIGNATURE",
      });
    });

    it("rejects a challenge built with an unauthorized home domain with 401 HOME_DOMAIN_MISMATCH", async () => {
      const client = Keypair.random();
      const rogueTransaction = WebAuth.buildChallengeTx(
        serverKeypair(),
        client.publicKey(),
        "rogue-domain.org",
        CHALLENGE_VALIDITY_SECONDS,
        config.networkPassphrase,
        config.WEB_AUTH_DOMAIN
      );
      const signedXdr = signAndEncode(client, rogueTransaction);

      await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({
        status: 401,
        code: "HOME_DOMAIN_MISMATCH",
      });
    });

    it("rejects expired challenge past validity window and skew allowance with 401 CHALLENGE_EXPIRED", async () => {
      vi.useFakeTimers();
      const { signedXdr } = validExchange();
      vi.advanceTimersByTime((CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 5) * 1000);

      await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({
        status: 401,
        code: "CHALLENGE_EXPIRED",
      });
    });

    it("prevents challenge replay attacks by rejecting a second verification attempt", async () => {
      const { client, signedXdr } = validExchange();
      const first = await verifyChallenge(signedXdr);
      expect(first).toBe(client.publicKey());

      // Second verification of the exact same envelope must fail as replayed
      await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({
        status: 401,
        code: "INVALID_CHALLENGE",
      });
    });
  });
});

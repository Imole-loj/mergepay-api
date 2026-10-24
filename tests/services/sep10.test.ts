import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Keypair,
  Transaction,
  WebAuth,
  Operation,
  Memo,
  TransactionBuilder,
  Account,
} from "@stellar/stellar-sdk";

// Mock store for consumed challenges so $executeRaw simulates Postgres atomic single-use insertion
const testHarness = vi.hoisted(() => {
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
  const deleteMany = vi.fn(async () => {
    return { count: 1 };
  });
  return { store, executeRaw, deleteMany };
});

vi.mock("../../src/db", () => ({
  prisma: {
    $executeRaw: testHarness.executeRaw,
    sep10Challenge: {
      deleteMany: testHarness.deleteMany,
    },
  },
}));

const mockAccounts = vi.hoisted(() => new Map<string, {
  exists: boolean;
  sequence: string;
  balances: unknown[];
  signers: { key: string; weight: number }[];
  thresholds: { low: number; med: number; high: number };
}>());

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async (accountId: string) => {
        const configured = mockAccounts.get(accountId);
        if (configured) return configured;
        return {
          exists: false,
          sequence: "0",
          balances: [],
          signers: [],
          thresholds: { low: 0, med: 0, high: 0 },
        };
      }),
    },
  };
});

import {
  buildChallenge,
  verifyChallenge,
  authenticateChallenge,
  validateChallengeTimeBounds,
  cleanupExpiredChallenges,
  serverKeypair,
  parseTransaction,
  CHALLENGE_VALIDITY_SECONDS,
} from "../../src/services/sep10";
import { config } from "../../src/config";

describe("SEP-10 Authentication Service Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testHarness.store.clear();
    mockAccounts.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Challenge Creation (buildChallenge)", () => {
    it("generates a valid challenge transaction for a legitimate Stellar public key", () => {
      const client = Keypair.random();
      const result = buildChallenge(client.publicKey());

      expect(result).toHaveProperty("transaction");
      expect(result.networkPassphrase).toBe(config.networkPassphrase);

      const tx = new Transaction(result.transaction, result.networkPassphrase);
      expect(tx.source).toBe(serverKeypair().publicKey());
      expect(tx.sequence).toBe("0");
      expect(tx.operations.length).toBeGreaterThanOrEqual(2);

      // Verify the auth operation
      const authOp = tx.operations[0];
      expect(authOp.type).toBe("manageData");
      if (authOp.type === "manageData") {
        expect(authOp.name).toBe(`${config.SEP10_HOME_DOMAIN} auth`);
        expect(authOp.source).toBe(client.publicKey());
        expect(authOp.value).toBeDefined();
        expect(authOp.value?.length).toBeGreaterThanOrEqual(48);
      }

      // Verify web_auth_domain operation
      const domainOp = tx.operations[1];
      expect(domainOp.type).toBe("manageData");
      if (domainOp.type === "manageData") {
        expect(domainOp.name).toBe("web_auth_domain");
        expect(domainOp.source).toBe(serverKeypair().publicKey());
        expect(Buffer.from(domainOp.value ?? "").toString("utf8")).toBe(config.WEB_AUTH_DOMAIN);
      }
    });

    it("rejects challenge creation for malformed public keys", () => {
      expect(() => buildChallenge("invalid-stellar-key")).toThrowError(/Not a valid Stellar public key/);
      expect(() => buildChallenge("")).toThrowError(/Not a valid Stellar public key/);
      expect(() => buildChallenge("G12345")).toThrowError(/Not a valid Stellar public key/);
    });

    it("rejects challenge creation for Stellar secret seeds", () => {
      const secret = Keypair.random().secret();
      expect(() => buildChallenge(secret)).toThrowError(/Not a valid Stellar public key/);
    });
  });

  describe("Time Bounds Validation (validateChallengeTimeBounds)", () => {
    it("accepts time bounds within the current active validity window", () => {
      const now = new Date(1700000000000);
      const nowSec = Math.floor(now.getTime() / 1000);
      const bounds = {
        minTime: nowSec - 10,
        maxTime: nowSec + 300,
      };

      expect(() => validateChallengeTimeBounds(bounds, now)).not.toThrow();
    });

    it("rejects null or non-positive maxTime bounds", () => {
      expect(() => validateChallengeTimeBounds(null)).toThrow();
      expect(() => validateChallengeTimeBounds({ minTime: 100, maxTime: 0 })).toThrow();
      expect(() => validateChallengeTimeBounds({ minTime: 100, maxTime: -50 })).toThrow();
    });

    it("rejects inverted time bounds where minTime > maxTime", () => {
      expect(() => validateChallengeTimeBounds({ minTime: 1000, maxTime: 500 })).toThrow();
    });

    it("rejects expired challenge time bounds", () => {
      const now = new Date(1700000000000);
      const nowSec = Math.floor(now.getTime() / 1000);
      const expiredBounds = {
        minTime: nowSec - 600,
        maxTime: nowSec - 120, // Expired 2 minutes ago
      };

      expect(() => validateChallengeTimeBounds(expiredBounds, now)).toThrow();
    });

    it("rejects time bounds that are not yet valid (premature window)", () => {
      const now = new Date(1700000000000);
      const nowSec = Math.floor(now.getTime() / 1000);
      const futureBounds = {
        minTime: nowSec + 120, // Window starts 2 minutes in the future
        maxTime: nowSec + 600,
      };

      expect(() => validateChallengeTimeBounds(futureBounds, now)).toThrow();
    });

    it("rejects time bounds whose window exceeds CHALLENGE_VALIDITY_SECONDS + tolerance", () => {
      const now = new Date(1700000000000);
      const nowSec = Math.floor(now.getTime() / 1000);
      const excessivelyLongBounds = {
        minTime: nowSec - 10,
        maxTime: nowSec + CHALLENGE_VALIDITY_SECONDS + 500,
      };

      expect(() => validateChallengeTimeBounds(excessivelyLongBounds, now)).toThrow();
    });
  });

  describe("Challenge Verification (verifyChallenge & authenticateChallenge)", () => {
    it("successfully verifies a challenge signed by the legitimate client for an unfunded account", async () => {
      const client = Keypair.random();
      const { transaction, networkPassphrase } = buildChallenge(client.publicKey());

      const tx = new Transaction(transaction, networkPassphrase);
      tx.sign(client);
      const signedXdr = tx.toXDR();

      const authenticatedAccount = await verifyChallenge(signedXdr);
      expect(authenticatedAccount).toBe(client.publicKey());
    });

    it("returns both account and challengeHash when calling authenticateChallenge", async () => {
      const client = Keypair.random();
      const { transaction, networkPassphrase } = buildChallenge(client.publicKey());

      const tx = new Transaction(transaction, networkPassphrase);
      tx.sign(client);
      const signedXdr = tx.toXDR();

      const result = await authenticateChallenge(signedXdr);
      expect(result.account).toBe(client.publicKey());
      expect(result.challengeHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("rejects a challenge that was never signed by the client (server signature only)", async () => {
      const client = Keypair.random();
      const { transaction } = buildChallenge(client.publicKey());

      await expect(verifyChallenge(transaction)).rejects.toThrow();
    });

    it("rejects a challenge signed by an unrelated keypair", async () => {
      const client = Keypair.random();
      const impostor = Keypair.random();
      const { transaction, networkPassphrase } = buildChallenge(client.publicKey());

      const tx = new Transaction(transaction, networkPassphrase);
      tx.sign(impostor);
      const signedXdr = tx.toXDR();

      await expect(verifyChallenge(signedXdr)).rejects.toThrow();
    });

    it("rejects a challenge transaction whose TTL has expired", async () => {
      vi.useFakeTimers();
      const client = Keypair.random();
      const { transaction, networkPassphrase } = buildChallenge(client.publicKey());

      const tx = new Transaction(transaction, networkPassphrase);
      tx.sign(client);
      const signedXdr = tx.toXDR();

      // Fast forward past validity window
      vi.advanceTimersByTime((CHALLENGE_VALIDITY_SECONDS + 120) * 1000);

      await expect(verifyChallenge(signedXdr)).rejects.toThrow();
    });

    it("prevents replay attacks by rejecting a challenge that has already been verified", async () => {
      const client = Keypair.random();
      const { transaction, networkPassphrase } = buildChallenge(client.publicKey());

      const tx = new Transaction(transaction, networkPassphrase);
      tx.sign(client);
      const signedXdr = tx.toXDR();

      // First verification succeeds
      const first = await verifyChallenge(signedXdr);
      expect(first).toBe(client.publicKey());

      // Second verification of the exact same XDR must fail
      await expect(verifyChallenge(signedXdr)).rejects.toThrow();
    });

    it("verifies multi-signer accounts with medium threshold on funded accounts", async () => {
      const client = Keypair.random();
      const signerA = Keypair.random();
      const signerB = Keypair.random();

      mockAccounts.set(client.publicKey(), {
        exists: true,
        sequence: "100",
        balances: [],
        signers: [
          { key: signerA.publicKey(), weight: 1 },
          { key: signerB.publicKey(), weight: 1 },
        ],
        thresholds: { low: 1, med: 2, high: 2 },
      });

      const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
      const tx = new Transaction(transaction, networkPassphrase);

      // Sign with signerA (weight 1, needs 2) -> should fail
      tx.sign(signerA);
      await expect(verifyChallenge(tx.toXDR())).rejects.toThrow();

      // Now add signerB (total weight 2 >= med threshold 2) -> should pass
      tx.sign(signerB);
      const verified = await verifyChallenge(tx.toXDR());
      expect(verified).toBe(client.publicKey());
    });
  });

  describe("Domain and Envelope Integrity Checks", () => {
    it("rejects a challenge envelope with mismatched home domain", async () => {
      const client = Keypair.random();
      const attackerServer = Keypair.random();

      // Construct a challenge with an incorrect home domain
      const foreignTx = WebAuth.buildChallengeTx(
        attackerServer,
        client.publicKey(),
        "malicious-domain.com",
        300,
        config.networkPassphrase,
        config.WEB_AUTH_DOMAIN
      );

      const tx = new Transaction(foreignTx, config.networkPassphrase);
      tx.sign(client);

      await expect(verifyChallenge(tx.toXDR())).rejects.toThrow();
    });

    it("rejects a challenge envelope with an unexpected memo", async () => {
      const client = Keypair.random();
      const server = serverKeypair();
      const now = Math.floor(Date.now() / 1000);

      const account = new Account(server.publicKey(), "0");
      const builder = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: config.networkPassphrase,
        timebounds: { minTime: now - 10, maxTime: now + 300 },
      });

      builder.addMemo(Memo.text("unauthorized-memo"));
      builder.addOperation(
        Operation.manageData({
          name: `${config.SEP10_HOME_DOMAIN} auth`,
          value: Buffer.from("random-nonce-bytes-0123456789012345678901234567890123456789"),
          source: client.publicKey(),
        })
      );
      builder.addOperation(
        Operation.manageData({
          name: "web_auth_domain",
          value: Buffer.from(config.WEB_AUTH_DOMAIN),
          source: server.publicKey(),
        })
      );

      const tx = builder.build();
      tx.sign(server);
      tx.sign(client);

      await expect(verifyChallenge(tx.toXDR())).rejects.toThrow();
    });

    it("rejects a challenge transaction with non-zero sequence number", async () => {
      const client = Keypair.random();
      const server = serverKeypair();
      const now = Math.floor(Date.now() / 1000);

      const account = new Account(server.publicKey(), "12345"); // Invalid sequence number
      const builder = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: config.networkPassphrase,
        timebounds: { minTime: now - 10, maxTime: now + 300 },
      });

      builder.addOperation(
        Operation.manageData({
          name: `${config.SEP10_HOME_DOMAIN} auth`,
          value: Buffer.from("random-nonce-bytes-0123456789012345678901234567890123456789"),
          source: client.publicKey(),
        })
      );
      builder.addOperation(
        Operation.manageData({
          name: "web_auth_domain",
          value: Buffer.from(config.WEB_AUTH_DOMAIN),
          source: server.publicKey(),
        })
      );

      const tx = builder.build();
      tx.sign(server);
      tx.sign(client);

      await expect(verifyChallenge(tx.toXDR())).rejects.toThrow();
    });
  });

  describe("Utility & Maintenance Functions", () => {
    it("parseTransaction successfully parses valid Stellar transaction XDR and throws on malformed input", () => {
      const client = Keypair.random();
      const { transaction } = buildChallenge(client.publicKey());

      const parsed = parseTransaction(transaction);
      expect(parsed).toBeInstanceOf(Transaction);
      expect(parsed.source).toBe(serverKeypair().publicKey());

      expect(() => parseTransaction("totally-invalid-xdr-string")).toThrow();
    });

    it("cleanupExpiredChallenges executes database purge for stale records", async () => {
      const deletedCount = await cleanupExpiredChallenges();
      expect(deletedCount).toBe(1);
      expect(testHarness.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: expect.any(Date) } },
      });
    });
  });
});

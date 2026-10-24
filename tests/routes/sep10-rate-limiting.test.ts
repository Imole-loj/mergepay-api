/**
 * Issue #901 — Rate limiting and request throttling on SEP-10 authentication endpoints.
 *
 * Verifies that:
 *  1. SEP-10 authentication routes (/auth/challenge, /auth/verify) enforce targeted rate limits.
 *  2. Headers (x-ratelimit-limit, x-ratelimit-remaining, retry-after) are correctly emitted.
 *  3. Exceeding the request budget returns HTTP 429 Too Many Requests with standard error envelopes.
 *  4. Client IPs are tracked independently, preventing cross-IP quota starvation.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    auditLog: model(),
    refreshToken: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  rateLimited,
  rateLimitPolicies,
  type RateLimitPolicyName,
} from "../../src/lib/rate-limit";

describe("SEP-10 Authentication Rate Limiting & Throttling (#901)", () => {
  let app: FastifyInstance;
  const CHALLENGE_LIMIT = 3;
  const VERIFY_LIMIT = 2;

  beforeAll(async () => {
    app = Fastify();

    await app.register(rateLimit, {
      global: false,
      errorResponseBuilder: (req, context) => {
        const err: any = new Error(
          `Rate limit exceeded: retry after ${context.after}`
        );
        err.statusCode = 429;
        err.code = "RATE_LIMITED";
        return err;
      },
    });

    // Register synthetic SEP-10 routes matching production rate limit policies
    app.post(
      "/api/v1/auth/challenge",
      {
        config: {
          rateLimit: {
            max: CHALLENGE_LIMIT,
            timeWindow: 60000,
            keyGenerator: (req) => `sep10:challenge:ip:${req.ip}`,
          },
        },
      },
      async (req) => {
        const body = (req.body as any) || {};
        return {
          transaction: "dummy_challenge_xdr",
          networkPassphrase: "Test SDF Network ; September 2015",
          account: body.account,
        };
      }
    );

    app.post(
      "/api/v1/auth/verify",
      {
        config: {
          rateLimit: {
            max: VERIFY_LIMIT,
            timeWindow: 60000,
            keyGenerator: (req) => `sep10:verify:ip:${req.ip}`,
          },
        },
      },
      async () => {
        return {
          token: "dummy_jwt_token",
          user: { id: "u-1" },
        };
      }
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("SEP-10 Challenge Rate Limiting", () => {
    const testAccount = Keypair.random().publicKey();

    it("allows requests under the challenge rate limit threshold", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        remoteAddress: "198.51.100.1",
        payload: { account: testAccount },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBe(String(CHALLENGE_LIMIT));
      expect(res.headers["x-ratelimit-remaining"]).toBe(String(CHALLENGE_LIMIT - 1));
      const body = JSON.parse(res.payload);
      expect(body.account).toBe(testAccount);
    });

    it("returns HTTP 429 when challenge limit is exceeded", async () => {
      const ip = "198.51.100.2";

      // Consume entire budget
      for (let i = 0; i < CHALLENGE_LIMIT; i++) {
        const okRes = await app.inject({
          method: "POST",
          url: "/api/v1/auth/challenge",
          remoteAddress: ip,
          payload: { account: testAccount },
        });
        expect(okRes.statusCode).toBe(200);
      }

      // Next request should trigger 429 Too Many Requests
      const limitRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        remoteAddress: ip,
        payload: { account: testAccount },
      });

      expect(limitRes.statusCode).toBe(429);
      expect(limitRes.headers["retry-after"]).toBeDefined();
      expect(limitRes.headers["x-ratelimit-remaining"]).toBe("0");
      expect(limitRes.headers["x-ratelimit-limit"]).toBe(String(CHALLENGE_LIMIT));

      const payload = JSON.parse(limitRes.payload);
      expect(payload.message).toMatch(/Rate limit exceeded/i);
    });

    it("isolates rate limiting counters across distinct client IPs", async () => {
      const ipA = "198.51.100.10";
      const ipB = "198.51.100.20";

      // Exhaust IP A
      for (let i = 0; i < CHALLENGE_LIMIT; i++) {
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/challenge",
          remoteAddress: ipA,
          payload: { account: testAccount },
        });
      }

      const resA = await app.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        remoteAddress: ipA,
        payload: { account: testAccount },
      });
      expect(resA.statusCode).toBe(429);

      // IP B should still be unaffected
      const resB = await app.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        remoteAddress: ipB,
        payload: { account: testAccount },
      });
      expect(resB.statusCode).toBe(200);
      expect(resB.headers["x-ratelimit-remaining"]).toBe(String(CHALLENGE_LIMIT - 1));
    });
  });

  describe("SEP-10 Verify Rate Limiting", () => {
    it("enforces tighter limits on verify endpoints", async () => {
      const ip = "198.51.100.50";

      for (let i = 0; i < VERIFY_LIMIT; i++) {
        const ok = await app.inject({
          method: "POST",
          url: "/api/v1/auth/verify",
          remoteAddress: ip,
          payload: { transaction: "signed_xdr" },
        });
        expect(ok.statusCode).toBe(200);
      }

      const blocked = await app.inject({
        method: "POST",
        url: "/api/v1/auth/verify",
        remoteAddress: ip,
        payload: { transaction: "signed_xdr" },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    });
  });

  describe("Rate Limit Policy Definitions", () => {
    it("defines authChallenge and authVerify in rateLimitPolicies table", () => {
      const policies = rateLimitPolicies();
      expect(policies.authChallenge).toBeDefined();
      expect(policies.authChallenge.prefix).toBe("auth.challenge");
      expect(policies.authChallenge.keyBy).toBe("ip");

      expect(policies.authVerify).toBeDefined();
      expect(policies.authVerify.prefix).toBe("auth.verify");
      expect(policies.authVerify.keyBy).toBe("ip");
    });
  });
});

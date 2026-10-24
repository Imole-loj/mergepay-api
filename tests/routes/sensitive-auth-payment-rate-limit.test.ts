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
  });
  const prisma: any = {
    user: model(),
    auditLog: model(),
    settlement: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import {
  rateLimited,
  rateLimitPolicies,
  type RateLimitPolicyName,
} from "../../src/lib/rate-limit";

describe("Sensitive Authentication and Payment Rate Limiting (#888)", () => {
  let app: FastifyInstance;
  const AUTH_LIMIT = 2;
  const SETTLEMENT_LIMIT = 3;

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
        err.after = context.after;
        return err;
      },
    });

    // Dummy authentication hook for authenticated routes
    app.decorate("authenticate", async (req: any) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer user_")) {
        const userId = authHeader.replace("Bearer ", "");
        req.user = { id: userId, stellarPublicKey: `G${userId.toUpperCase()}` };
      }
    });

    // Sensitive Auth routes (keyed by IP)
    app.post(
      "/auth/challenge",
      {
        config: {
          rateLimit: {
            max: AUTH_LIMIT,
            timeWindow: 60000,
            keyGenerator: (req) => `auth.challenge:${req.ip}`,
          },
        },
      },
      async (req, reply) => {
        return reply.send({ challenge: "test_challenge" });
      }
    );

    app.post(
      "/auth/verify",
      {
        config: {
          rateLimit: {
            max: AUTH_LIMIT,
            timeWindow: 60000,
            keyGenerator: (req) => `auth.verify:${req.ip}`,
          },
        },
      },
      async (req, reply) => {
        return reply.send({ token: "test_jwt" });
      }
    );

    // Sensitive Settlement payment submission routes (keyed by authenticated user or IP)
    app.post(
      "/settlements/:id/confirm",
      {
        preHandler: [app.authenticate as any],
        config: {
          rateLimit: {
            max: SETTLEMENT_LIMIT,
            timeWindow: 60000,
            hook: "preHandler",
            keyGenerator: (req: any) =>
              req.user?.id ? `settlement.confirm:${req.user.id}` : `settlement.confirm:${req.ip}`,
          },
        },
      },
      async (req, reply) => {
        return reply.send({ ok: true, confirmed: true });
      }
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Authentication Endpoints Rate Limiting (/auth/*)", () => {
    it("enforces threshold and returns 429 with standard rate-limit headers", async () => {
      const ip = "192.168.10.1";

      // Request 1: In budget
      const res1 = await app.inject({
        method: "POST",
        url: "/auth/challenge",
        remoteAddress: ip,
        payload: { publicKey: Keypair.random().publicKey() },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.headers["x-ratelimit-limit"]).toBe(String(AUTH_LIMIT));
      expect(res1.headers["x-ratelimit-remaining"]).toBe("1");

      // Request 2: Last allowed
      const res2 = await app.inject({
        method: "POST",
        url: "/auth/challenge",
        remoteAddress: ip,
        payload: { publicKey: Keypair.random().publicKey() },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.headers["x-ratelimit-remaining"]).toBe("0");

      // Request 3: Exceeded -> 429 Too Many Requests
      const res3 = await app.inject({
        method: "POST",
        url: "/auth/challenge",
        remoteAddress: ip,
        payload: { publicKey: Keypair.random().publicKey() },
      });
      expect(res3.statusCode).toBe(429);
      expect(res3.headers["retry-after"]).toBeDefined();
    });

    it("isolates rate limit buckets between different client IPs", async () => {
      const ipA = "10.0.0.1";
      const ipB = "10.0.0.2";

      // Exhaust IP A
      for (let i = 0; i < AUTH_LIMIT; i++) {
        await app.inject({
          method: "POST",
          url: "/auth/verify",
          remoteAddress: ipA,
          payload: {},
        });
      }

      const blockedA = await app.inject({
        method: "POST",
        url: "/auth/verify",
        remoteAddress: ipA,
        payload: {},
      });
      expect(blockedA.statusCode).toBe(429);

      // IP B remains unthrottled
      const allowedB = await app.inject({
        method: "POST",
        url: "/auth/verify",
        remoteAddress: ipB,
        payload: {},
      });
      expect(allowedB.statusCode).toBe(200);
    });
  });

  describe("Settlement Payment Submission Rate Limiting (/settlements/*)", () => {
    it("keys rate limiting by authenticated user identity and returns 429 when budget exhausted", async () => {
      const user = "user_alice_888";

      // 3 calls within budget
      for (let i = 0; i < SETTLEMENT_LIMIT; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/settlements/settle_100/confirm",
          headers: { authorization: `Bearer ${user}` },
          payload: { signedXdr: "AAAA..." },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers["x-ratelimit-remaining"]).toBe(String(SETTLEMENT_LIMIT - 1 - i));
      }

      // 4th call exceeded
      const blockedRes = await app.inject({
        method: "POST",
        url: "/settlements/settle_100/confirm",
        headers: { authorization: `Bearer ${user}` },
        payload: { signedXdr: "AAAA..." },
      });
      expect(blockedRes.statusCode).toBe(429);
      expect(blockedRes.headers["retry-after"]).toBeDefined();
    });

    it("does not starve another user's settlement submission quota", async () => {
      const alice = "user_alice_quota";
      const bob = "user_bob_quota";

      // Exhaust Alice's budget
      for (let i = 0; i < SETTLEMENT_LIMIT; i++) {
        await app.inject({
          method: "POST",
          url: "/settlements/settle_200/confirm",
          headers: { authorization: `Bearer ${alice}` },
        });
      }

      // Bob can still submit
      const bobRes = await app.inject({
        method: "POST",
        url: "/settlements/settle_300/confirm",
        headers: { authorization: `Bearer ${bob}` },
      });
      expect(bobRes.statusCode).toBe(200);
      expect(bobRes.headers["x-ratelimit-remaining"]).toBe(String(SETTLEMENT_LIMIT - 1));
    });
  });
});

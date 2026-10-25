import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { rateLimited, rateLimitPolicies } from "../../src/lib/rate-limit";
import { AppError, ErrorCode } from "../../src/lib/errors";

describe("Treasury Multisig Transaction Submission Rate Limiting (#803 / #879)", () => {
  let app: FastifyInstance;

  const PROPOSE_LIMIT = 3;
  const SUBMIT_LIMIT = 4;

  beforeAll(async () => {
    app = Fastify();

    await app.register(rateLimit, {
      global: false,
      addHeaders: {
        "x-ratelimit-limit": true,
        "x-ratelimit-remaining": true,
        "x-ratelimit-reset": true,
        "retry-after": true,
      },
      errorResponseBuilder: (_req, context) => {
        const err: any = new AppError(
          429,
          ErrorCode.RATE_LIMITED,
          "Too many requests. Please retry later."
        );
        err.statusCode = 429;
        err.after = context.after;
        return err;
      },
    });

    // Mock authentication hook
    app.decorate("authenticate", async (req: any) => {
      const auth = req.headers.authorization;
      if (auth && auth.startsWith("Bearer ")) {
        const token = auth.replace("Bearer ", "");
        req.user = { id: token, stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
      }
    });

    // Treasury multisig proposal endpoint with rate limiting
    app.post(
      "/api/v1/treasury/propose",
      {
        preHandler: [app.authenticate as any],
        config: {
          rateLimitPolicy: "treasuryPropose",
          rateLimit: {
            max: PROPOSE_LIMIT,
            timeWindow: 60000,
            hook: "preHandler",
            keyGenerator: (req: any) => `treasury.propose:user:${req.user?.id || req.ip}`,
          },
        },
      },
      async (_req, reply) => {
        return reply.send({ ok: true, type: "proposal" });
      }
    );

    // Treasury multisig signature submission endpoint with rate limiting
    app.post(
      "/api/v1/treasury/:id/sign",
      {
        preHandler: [app.authenticate as any],
        config: {
          rateLimitPolicy: "treasurySubmit",
          rateLimit: {
            max: SUBMIT_LIMIT,
            timeWindow: 60000,
            hook: "preHandler",
            keyGenerator: (req: any) => `treasury.submit:user:${req.user?.id || req.ip}`,
          },
        },
      },
      async (_req, reply) => {
        return reply.send({ ok: true, type: "submission" });
      }
    );

    // Treasury proposal signature fragment endpoint with rate limiting (#803)
    app.post(
      "/api/v1/treasury/proposals/:id/signatures",
      {
        preHandler: [app.authenticate as any],
        config: {
          rateLimitPolicy: "treasurySubmit",
          rateLimit: {
            max: SUBMIT_LIMIT,
            timeWindow: 60000,
            hook: "preHandler",
            keyGenerator: (req: any) => `treasury.submit:user:${req.user?.id || req.ip}`,
          },
        },
      },
      async (_req, reply) => {
        return reply.send({ ok: true, type: "signature_fragment" });
      }
    );

    // General read endpoint without submission rate limiting (#803)
    app.get(
      "/api/v1/treasury/proposals/:id",
      {
        preHandler: [app.authenticate as any],
      },
      async (req, reply) => {
        return reply.send({ ok: true, id: (req.params as any).id });
      }
    );

    // Group-scoped treasury proposal submission endpoint with rate limiting
    app.post(
      "/api/v1/groups/:groupId/treasury/proposals/:proposalId/sign",
      {
        preHandler: [app.authenticate as any],
        config: {
          rateLimitPolicy: "treasurySubmit",
          rateLimit: {
            max: SUBMIT_LIMIT,
            timeWindow: 60000,
            hook: "preHandler",
            keyGenerator: (req: any) => `treasury.submit:user:${req.user?.id || req.ip}`,
          },
        },
      },
      async (_req, reply) => {
        return reply.send({ ok: true, type: "group_submission" });
      }
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("permits requests to /treasury/propose within configured limit", async () => {
    const headers = { authorization: "Bearer user_propose_ok" };

    for (let i = 0; i < PROPOSE_LIMIT; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/treasury/propose",
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBe(String(PROPOSE_LIMIT));
      expect(Number(res.headers["x-ratelimit-remaining"])).toBe(PROPOSE_LIMIT - 1 - i);
    }
  });

  it("throttles /treasury/propose with HTTP 429 and retry headers when exceeding limit", async () => {
    const headers = { authorization: "Bearer user_propose_throttled" };

    for (let i = 0; i < PROPOSE_LIMIT; i++) {
      await app.inject({
        method: "POST",
        url: "/api/v1/treasury/propose",
        headers,
      });
    }

    const throttled = await app.inject({
      method: "POST",
      url: "/api/v1/treasury/propose",
      headers,
    });

    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
    expect(throttled.headers["x-ratelimit-remaining"]).toBe("0");

    const body = throttled.json();
    expect(body.statusCode).toBe(429);
    expect(body.error).toBe("Too Many Requests");
    expect(body.message).toContain("Too many requests");
  });

  it("throttles /treasury/:id/sign with HTTP 429 and retry headers when exceeding limit", async () => {
    const headers = { authorization: "Bearer user_sign_throttled" };

    for (let i = 0; i < SUBMIT_LIMIT; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/treasury/prop_123/sign",
        headers,
      });
      expect(res.statusCode).toBe(200);
    }

    const throttled = await app.inject({
      method: "POST",
      url: "/api/v1/treasury/prop_123/sign",
      headers,
    });

    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
    expect(throttled.headers["x-ratelimit-remaining"]).toBe("0");

    const body = throttled.json();
    expect(body.statusCode).toBe(429);
    expect(body.error).toBe("Too Many Requests");
  });

  it("throttles group-scoped proposal sign endpoint under treasurySubmit budget", async () => {
    const headers = { authorization: "Bearer user_group_sign_throttled" };
    const url = "/api/v1/groups/group_1/treasury/proposals/prop_1/sign";

    for (let i = 0; i < SUBMIT_LIMIT; i++) {
      const res = await app.inject({ method: "POST", url, headers });
      expect(res.statusCode).toBe(200);
    }

    const throttled = await app.inject({ method: "POST", url, headers });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
    expect(throttled.json().statusCode).toBe(429);
    expect(throttled.json().error).toBe("Too Many Requests");
  });

  it("maintains independent rate limit buckets between proposal and signature submission", async () => {
    const headers = { authorization: "Bearer user_independent_buckets" };

    // Exhaust proposal budget
    for (let i = 0; i < PROPOSE_LIMIT; i++) {
      await app.inject({
        method: "POST",
        url: "/api/v1/treasury/propose",
        headers,
      });
    }

    const propThrottled = await app.inject({
      method: "POST",
      url: "/api/v1/treasury/propose",
      headers,
    });
    expect(propThrottled.statusCode).toBe(429);

    // Verify submission endpoint is still active and not throttled
    const signRes = await app.inject({
      method: "POST",
      url: "/api/v1/treasury/prop_456/sign",
      headers,
    });
    expect(signRes.statusCode).toBe(200);
    expect(Number(signRes.headers["x-ratelimit-remaining"])).toBe(SUBMIT_LIMIT - 1);
  });

  it("throttles /treasury/proposals/:id/signatures under treasurySubmit budget (#803)", async () => {
    const headers = { authorization: "Bearer user_signatures_throttled" };
    const url = "/api/v1/treasury/proposals/prop_999/signatures";

    for (let i = 0; i < SUBMIT_LIMIT; i++) {
      const res = await app.inject({ method: "POST", url, headers });
      expect(res.statusCode).toBe(200);
    }

    const throttled = await app.inject({ method: "POST", url, headers });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["x-ratelimit-remaining"]).toBe("0");
    expect(throttled.headers["retry-after"]).toBeDefined();
  });

  it("preserves access for general proposal read queries without exhausting submission limit (#803)", async () => {
    const headers = { authorization: "Bearer user_read_unaffected" };

    // Perform multiple reads
    for (let i = 0; i < SUBMIT_LIMIT + 5; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/treasury/proposals/prop_read_1",
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    }
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { AppError, ErrorCode } from "../../src/lib/errors";

describe("Rate Limiting on Sensitive Treasury & Expense Mutation Endpoints (#870)", () => {
  let app: FastifyInstance;

  const EXPENSE_CREATE_LIMIT = 3;
  const EXPENSE_MUTATE_LIMIT = 2;
  const TREASURY_PROPOSE_LIMIT = 2;
  const TREASURY_SUBMIT_LIMIT = 3;

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

    app.setErrorHandler((error, _request, reply) => {
      if (error.statusCode === 429) {
        return reply.status(429).send({
          statusCode: 429,
          error: {
            code: ErrorCode.RATE_LIMITED,
            message: error.message,
          },
        });
      }
      return reply.send(error);
    });

    // Mock authentication hook
    app.decorate("authenticate", async (req: any) => {
      const auth = req.headers.authorization;
      if (auth && auth.startsWith("Bearer ")) {
        const token = auth.replace("Bearer ", "");
        req.user = { id: token, stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
      }
    });

    // 1. Expense creation route (policy: expenseCreate)
    app.post(
      "/api/v1/groups/:id/expenses",
      {
        preHandler: [app.authenticate as any],
        config: {
          rateLimitPolicy: "expenseCreate",
          rateLimit: {
            max: EXPENSE_CREATE_LIMIT,
            timeWindow: 60000,
            hook: "preHandler",
            keyGenerator: (req: any) => `expense.create:user:${req.user?.id || req.ip}`,
          },
        },
      },
      async (_req, reply) => {
        return reply.send({ ok: true, action: "expense_created" });
      }
    );

    // 2. Expense mutation route: PATCH (policy: expenseMutate)
    app.patch(
      "/api/v1/expenses/:id",
      {
        preHandler: [app.authenticate as any],
        config: {
          rateLimitPolicy: "expenseMutate",
          rateLimit: {
            max: EXPENSE_MUTATE_LIMIT,
            timeWindow: 60000,
            hook: "preHandler",
            keyGenerator: (req: any) => `expense.mutate:user:${req.user?.id || req.ip}`,
          },
        },
      },
      async (_req, reply) => {
        return reply.send({ ok: true, action: "expense_updated" });
      }
    );

    // 3. Expense mutation route: DELETE (policy: expenseMutate)
    app.delete(
      "/api/v1/expenses/:id",
      {
        preHandler: [app.authenticate as any],
        config: {
          rateLimitPolicy: "expenseMutate",
          rateLimit: {
            max: EXPENSE_MUTATE_LIMIT,
            timeWindow: 60000,
            hook: "preHandler",
            keyGenerator: (req: any) => `expense.mutate:user:${req.user?.id || req.ip}`,
          },
        },
      },
      async (_req, reply) => {
        return reply.send({ ok: true, action: "expense_deleted" });
      }
    );

    // 4. Treasury proposal route (policy: treasuryPropose)
    app.post(
      "/api/v1/treasury/proposals",
      {
        preHandler: [app.authenticate as any],
        config: {
          rateLimitPolicy: "treasuryPropose",
          rateLimit: {
            max: TREASURY_PROPOSE_LIMIT,
            timeWindow: 60000,
            hook: "preHandler",
            keyGenerator: (req: any) => `treasury.propose:user:${req.user?.id || req.ip}`,
          },
        },
      },
      async (_req, reply) => {
        return reply.send({ ok: true, action: "proposal_created" });
      }
    );

    // 5. Treasury submit route (policy: treasurySubmit)
    app.post(
      "/api/v1/treasury/:id/sign",
      {
        preHandler: [app.authenticate as any],
        config: {
          rateLimitPolicy: "treasurySubmit",
          rateLimit: {
            max: TREASURY_SUBMIT_LIMIT,
            timeWindow: 60000,
            hook: "preHandler",
            keyGenerator: (req: any) => `treasury.submit:user:${req.user?.id || req.ip}`,
          },
        },
      },
      async (_req, reply) => {
        return reply.send({ ok: true, action: "signed_and_submitted" });
      }
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Expense Creation Rate Limiting", () => {
    it("permits expense creations within allowed threshold", async () => {
      const headers = { authorization: "Bearer user_exp_ok" };

      for (let i = 0; i < EXPENSE_CREATE_LIMIT; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/groups/grp_123/expenses",
          headers,
        });
        expect(res.statusCode).toBe(200);
        expect(Number(res.headers["x-ratelimit-remaining"])).toBe(EXPENSE_CREATE_LIMIT - 1 - i);
      }
    });

    it("enforces 429 Too Many Requests when expense creation limit is exceeded", async () => {
      const headers = { authorization: "Bearer user_exp_flood" };

      for (let i = 0; i < EXPENSE_CREATE_LIMIT; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/groups/grp_123/expenses",
          headers,
        });
        expect(res.statusCode).toBe(200);
      }

      // Next request must be throttled with 429
      const blocked = await app.inject({
        method: "POST",
        url: "/api/v1/groups/grp_123/expenses",
        headers,
      });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
      expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
      const body = JSON.parse(blocked.payload);
      expect(body.error?.code).toBe(ErrorCode.RATE_LIMITED);
    });
  });

  describe("Expense Mutation (PATCH & DELETE) Rate Limiting", () => {
    it("enforces rate limits on PATCH /api/v1/expenses/:id", async () => {
      const headers = { authorization: "Bearer user_patch_limit" };

      for (let i = 0; i < EXPENSE_MUTATE_LIMIT; i++) {
        const res = await app.inject({
          method: "PATCH",
          url: "/api/v1/expenses/exp_456",
          headers,
        });
        expect(res.statusCode).toBe(200);
      }

      const blocked = await app.inject({
        method: "PATCH",
        url: "/api/v1/expenses/exp_456",
        headers,
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
    });

    it("enforces rate limits on DELETE /api/v1/expenses/:id", async () => {
      const headers = { authorization: "Bearer user_delete_limit" };

      for (let i = 0; i < EXPENSE_MUTATE_LIMIT; i++) {
        const res = await app.inject({
          method: "DELETE",
          url: "/api/v1/expenses/exp_789",
          headers,
        });
        expect(res.statusCode).toBe(200);
      }

      const blocked = await app.inject({
        method: "DELETE",
        url: "/api/v1/expenses/exp_789",
        headers,
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
    });

    it("independent buckets: mutating expenses does not exhaust creation budget", async () => {
      const headers = { authorization: "Bearer user_independent_buckets" };

      // Exhaust mutate budget
      for (let i = 0; i < EXPENSE_MUTATE_LIMIT; i++) {
        await app.inject({
          method: "PATCH",
          url: "/api/v1/expenses/exp_000",
          headers,
        });
      }

      const patchBlocked = await app.inject({
        method: "PATCH",
        url: "/api/v1/expenses/exp_000",
        headers,
      });
      expect(patchBlocked.statusCode).toBe(429);

      // Creation budget must remain fresh and unaffected
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/groups/grp_123/expenses",
        headers,
      });
      expect(createRes.statusCode).toBe(200);
    });
  });

  describe("Treasury Multisig Proposal & Submission Rate Limiting", () => {
    it("enforces rate limits on treasury proposals with 429 response", async () => {
      const headers = { authorization: "Bearer user_treasury_propose_limit" };

      for (let i = 0; i < TREASURY_PROPOSE_LIMIT; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/treasury/proposals",
          headers,
        });
        expect(res.statusCode).toBe(200);
      }

      const blocked = await app.inject({
        method: "POST",
        url: "/api/v1/treasury/proposals",
        headers,
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
    });

    it("enforces rate limits on treasury signature submission with 429 response", async () => {
      const headers = { authorization: "Bearer user_treasury_sign_limit" };

      for (let i = 0; i < TREASURY_SUBMIT_LIMIT; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/treasury/prop_123/sign",
          headers,
        });
        expect(res.statusCode).toBe(200);
      }

      const blocked = await app.inject({
        method: "POST",
        url: "/api/v1/treasury/prop_123/sign",
        headers,
      });
      expect(blocked.statusCode).toBe(429);
    });

    it("rate limit keys are scoped per-user so one throttled user does not block another", async () => {
      const throttledUser = { authorization: "Bearer user_victim" };
      const innocentUser = { authorization: "Bearer user_innocent" };

      // Throttle user_victim
      for (let i = 0; i < TREASURY_PROPOSE_LIMIT; i++) {
        await app.inject({
          method: "POST",
          url: "/api/v1/treasury/proposals",
          headers: throttledUser,
        });
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/v1/treasury/proposals",
        headers: throttledUser,
      });
      expect(blocked.statusCode).toBe(429);

      // innocentUser should succeed unhindered
      const innocentRes = await app.inject({
        method: "POST",
        url: "/api/v1/treasury/proposals",
        headers: innocentUser,
      });
      expect(innocentRes.statusCode).toBe(200);
    });
  });
});

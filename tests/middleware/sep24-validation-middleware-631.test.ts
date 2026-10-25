import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import {
  validateSep24DepositMiddleware,
  validateSep24WithdrawMiddleware,
  createSep24ValidationMiddleware,
} from "../../src/middleware/sep24-validation";
import {
  sep24DepositRequestSchema,
  sep24WithdrawRequestSchema,
  sep24InitQuerySchema,
} from "../../src/validations/sep24";

describe("SEP-24 Zod Request Validation Middleware (#631)", () => {
  const validKey = Keypair.random().publicKey();

  describe("Middleware Factories", () => {
    it("createSep24ValidationMiddleware returns appropriate handlers", () => {
      const depositMiddleware = createSep24ValidationMiddleware("deposit");
      const withdrawMiddleware = createSep24ValidationMiddleware("withdrawal");

      expect(depositMiddleware).toBeDefined();
      expect(withdrawMiddleware).toBeDefined();
    });
  });

  describe("Route Integration & Error Handling", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = Fastify({ logger: false });

      app.setErrorHandler((error, _req, reply) => {
        if (error.name === "ZodError" || (error as any).issues) {
          return reply.status(400).send({
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            issues: (error as any).issues,
          });
        }
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      });

      app.post("/test/deposit", {
        preHandler: validateSep24DepositMiddleware,
        handler: async (req, reply) => {
          return reply.send({ ok: true, data: req.body });
        },
      });

      app.post("/test/withdraw", {
        preHandler: validateSep24WithdrawMiddleware,
        handler: async (req, reply) => {
          return reply.send({ ok: true, data: req.body });
        },
      });

      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("accepts valid deposit request with normal Stellar asset and valid destination", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/deposit?lang=en",
        payload: {
          assetCode: "USDC",
          account: validKey,
          amount: "50.00",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it("rejects deposit request with invalid or missing assetCode", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/deposit",
        payload: {
          account: validKey,
          // missing assetCode
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });

    it("rejects deposit request with malformed destination account", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/deposit",
        payload: {
          assetCode: "USDC",
          account: "G_INVALID_ACCOUNT_NOT_ED25519",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });

    it("rejects deposit request with invalid custom query parameter", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/deposit?unknownParam=invalid",
        payload: {
          assetCode: "USDC",
          account: validKey,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });

    it("accepts valid withdraw request with positive amount and valid asset", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/withdraw",
        payload: {
          assetCode: "XLM",
          amount: "100.50",
          account: validKey,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it("rejects withdraw request when amount parameter is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/withdraw",
        payload: {
          assetCode: "USDC",
          account: validKey,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });

    it("rejects withdraw request with non-positive amount", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/withdraw",
        payload: {
          assetCode: "USDC",
          amount: "0",
          account: validKey,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });

    it("rejects withdraw request with invalid asset code containing special characters", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/withdraw",
        payload: {
          assetCode: "USDC$$$BAD",
          amount: "10.00",
          account: validKey,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });
  });
});

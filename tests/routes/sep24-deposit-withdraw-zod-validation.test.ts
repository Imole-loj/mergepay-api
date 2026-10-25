import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import {
  sep24DepositParamsSchema,
  sep24WithdrawParamsSchema,
  validateSep24DepositParams,
  validateSep24WithdrawParams,
  validateSep24Deposit,
  validateSep24Withdraw,
} from "../../src/schemas/sep24";

describe("SEP-24 Deposit and Withdrawal Zod Request Validation (#799)", () => {
  const validKey = Keypair.random().publicKey();

  describe("sep24DepositParamsSchema & validateSep24DepositParams", () => {
    it("accepts valid deposit query and body", () => {
      const data = {
        query: { lang: "en" },
        body: {
          account: validKey,
          assetCode: "USDC",
          amount: "100.00",
          memo: "order123",
          memoType: "text" as const,
        },
      };

      const parsed = validateSep24DepositParams(data);
      expect(parsed.query?.lang).toBe("en");
      expect(parsed.body.assetCode).toBe("USDC");
      expect(parsed.body.account).toBe(validKey);
      expect(parsed.body.amount).toBe("100.00");
    });

    it("rejects deposit payload without assetCode", () => {
      expect(() =>
        validateSep24DepositParams({
          body: {
            account: validKey,
          },
        })
      ).toThrow();
    });

    it("rejects deposit payload with invalid Stellar address", () => {
      expect(() =>
        validateSep24DepositParams({
          body: {
            account: "INVALID_KEY_123",
            assetCode: "USDC",
          },
        })
      ).toThrow();
    });

    it("rejects memo without memoType", () => {
      expect(() =>
        validateSep24DepositParams({
          body: {
            account: validKey,
            assetCode: "USDC",
            memo: "orphan_memo",
          },
        })
      ).toThrow(/memoType is required/);
    });

    it("rejects unexpected query parameters (strict query validation)", () => {
      expect(() =>
        validateSep24DepositParams({
          query: { unexpectedField: "hack" },
          body: {
            account: validKey,
            assetCode: "USDC",
          },
        })
      ).toThrow();
    });

    it("rejects native XLM asset code with an assetIssuer", () => {
      expect(() =>
        validateSep24DepositParams({
          body: {
            account: validKey,
            assetCode: "XLM",
            assetIssuer: validKey,
          },
        })
      ).toThrow(/native asset/);
    });
  });

  describe("sep24WithdrawParamsSchema & validateSep24WithdrawParams", () => {
    it("accepts valid withdrawal query and body with amount", () => {
      const data = {
        query: { lang: "es" },
        body: {
          account: validKey,
          assetCode: "USDC",
          amount: "50.5000000",
        },
      };

      const parsed = validateSep24WithdrawParams(data);
      expect(parsed.query?.lang).toBe("es");
      expect(parsed.body.amount).toBe("50.5000000");
      expect(parsed.body.assetCode).toBe("USDC");
    });

    it("rejects withdrawal payload when amount is missing", () => {
      expect(() =>
        validateSep24WithdrawParams({
          body: {
            account: validKey,
            assetCode: "USDC",
          },
        })
      ).toThrow();
    });

    it("rejects withdrawal payload with negative amount", () => {
      expect(() =>
        validateSep24WithdrawParams({
          body: {
            account: validKey,
            assetCode: "USDC",
            amount: "-10.00",
          },
        })
      ).toThrow();
    });

    it("rejects withdrawal payload with excess decimal precision (> 7 decimals)", () => {
      expect(() =>
        validateSep24WithdrawParams({
          body: {
            account: validKey,
            assetCode: "USDC",
            amount: "10.12345678",
          },
        })
      ).toThrow();
    });
  });

  describe("Fastify Route Validation Middleware integration", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = Fastify({ logger: false });

      app.setErrorHandler((error, _req, reply) => {
        if (error.name === "ZodError" || (error as any).issues) {
          return reply.status(400).send({
            error: "VALIDATION_ERROR",
            message: "Request validation failed",
            issues: (error as any).issues,
          });
        }
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      });

      // Register deposit route with validateSep24Deposit preHandler
      app.post("/test/sep24/deposit", {
        preHandler: validateSep24Deposit,
        handler: async (req, reply) => {
          return reply.send({ success: true, body: req.body });
        },
      });

      // Register withdraw route with validateSep24Withdraw preHandler
      app.post("/test/sep24/withdraw", {
        preHandler: validateSep24Withdraw,
        handler: async (req, reply) => {
          return reply.send({ success: true, body: req.body });
        },
      });

      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("passes valid deposit request through route middleware", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/deposit",
        payload: {
          account: validKey,
          assetCode: "USDC",
          amount: "100.00",
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
    });

    it("rejects malformed deposit request with 400 VALIDATION_ERROR", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/deposit",
        payload: {
          account: "invalid-key",
          // missing assetCode
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.issues).toBeDefined();
    });

    it("rejects deposit request with invalid query parameter", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/deposit?evilParam=true",
        payload: {
          account: validKey,
          assetCode: "USDC",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("passes valid withdraw request through route middleware", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/withdraw",
        payload: {
          account: validKey,
          assetCode: "USDC",
          amount: "250.00",
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
    });

    it("rejects withdraw request missing amount with 400 VALIDATION_ERROR", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/withdraw",
        payload: {
          account: validKey,
          assetCode: "USDC",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });
  });
});

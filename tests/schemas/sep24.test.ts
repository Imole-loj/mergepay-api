/**
 * Issue #899 — Unit tests for SEP-24 anchor deposit and withdrawal Zod validation schemas and middleware.
 *
 * Verifies that:
 *  1. Deposit and withdrawal request bodies and queries are strictly validated with Zod.
 *  2. Malformed parameters (invalid Stellar public keys, negative amounts, missing asset codes) fail with HTTP 400.
 *  3. Valid deposit/withdrawal requests pass validation cleanly.
 *  4. Middleware correctly intercepts and validates requests in the Fastify preHandler hook.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import {
  validateSep24Deposit,
  validateSep24Withdraw,
  sep24DepositRequestSchema,
  sep24WithdrawRequestSchema,
  sep24InitQuerySchema,
  sep24CallbackSchema,
} from "../../src/schemas/sep24";

describe("SEP-24 Anchor Request Validation Schemas & Middleware (#899)", () => {
  const validAccount = Keypair.random().publicKey();

  describe("sep24InitQuerySchema", () => {
    it("accepts valid query parameters", () => {
      const parsed = sep24InitQuerySchema.parse({
        lang: "en",
      });
      expect(parsed.lang).toBe("en");
    });

    it("rejects unknown query parameters (strict)", () => {
      expect(() =>
        sep24InitQuerySchema.parse({
          asset_code: "USDC",
        })
      ).toThrow();
    });
  });

  describe("sep24DepositRequestSchema", () => {
    it("validates compliant deposit body", () => {
      const valid = sep24DepositRequestSchema.parse({
        account: validAccount,
        assetCode: "USDC",
        amount: "100.50",
        memo: "12345",
        memoType: "id",
      });
      expect(valid.account).toBe(validAccount);
      expect(valid.amount).toBe("100.50");
      expect(valid.assetCode).toBe("USDC");
    });

    it("rejects invalid Stellar public key", () => {
      expect(() =>
        sep24DepositRequestSchema.parse({
          account: "INVALID_NOT_A_KEY",
          assetCode: "USDC",
        })
      ).toThrow();
    });

    it("rejects negative amount", () => {
      expect(() =>
        sep24DepositRequestSchema.parse({
          account: validAccount,
          assetCode: "USDC",
          amount: "-50.00",
        })
      ).toThrow();
    });
  });

  describe("sep24WithdrawRequestSchema", () => {
    it("validates compliant withdrawal body", () => {
      const valid = sep24WithdrawRequestSchema.parse({
        account: validAccount,
        assetCode: "XLM",
        amount: "250.0000000",
      });
      expect(valid.amount).toBe("250.0000000");
      expect(valid.assetCode).toBe("XLM");
    });

    it("rejects withdrawal without amount", () => {
      expect(() =>
        sep24WithdrawRequestSchema.parse({
          account: validAccount,
          assetCode: "XLM",
        })
      ).toThrow();
    });
  });

  describe("sep24CallbackSchema", () => {
    it("parses valid top-level callback payload", () => {
      const parsed = sep24CallbackSchema.parse({
        id: "tx-sep24-001",
        status: "completed",
        amount_in: "100",
        amount_out: "99",
      });
      expect(parsed.externalTransactionId).toBe("tx-sep24-001");
      expect(parsed.rawStatus).toBe("completed");
    });

    it("parses valid nested transaction callback payload", () => {
      const parsed = sep24CallbackSchema.parse({
        transaction: {
          id: "tx-nested-002",
          status: "pending_anchor",
          amount_fee: "1.0",
        },
      });
      expect(parsed.externalTransactionId).toBe("tx-nested-002");
      expect(parsed.rawStatus).toBe("pending_anchor");
    });

    it("rejects payload lacking transaction identifier", () => {
      expect(() =>
        sep24CallbackSchema.parse({
          status: "completed",
        })
      ).toThrow();
    });
  });

  describe("Fastify Route Middleware Integration", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify();

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

      app.post(
        "/api/sep24/deposit",
        { preHandler: [validateSep24Deposit] },
        async (_req) => ({ ok: true, flow: "deposit" })
      );

      app.post(
        "/api/sep24/withdraw",
        { preHandler: [validateSep24Withdraw] },
        async (_req) => ({ ok: true, flow: "withdraw" })
      );

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("allows valid deposit request through middleware", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit?lang=en",
        payload: {
          account: validAccount,
          assetCode: "USDC",
          amount: "50",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it("rejects malformed deposit body with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit",
        payload: {
          account: "BAD_KEY",
          assetCode: "INVALID_TOO_LONG_CODE_123",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });

    it("allows valid withdrawal request through middleware", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/withdraw?lang=en",
        payload: {
          account: validAccount,
          assetCode: "XLM",
          amount: "75.00",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it("rejects withdrawal missing required amount with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/withdraw",
        payload: {
          account: validAccount,
          assetCode: "XLM",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import errorHandler from "../../src/plugins/error-handler";
import {
  validateSep24DepositParams,
  validateSep24WithdrawParams,
  sep24DepositParamsSchema,
  sep24WithdrawParamsSchema,
  sep24DepositParametersSchema,
  sep24WithdrawParametersSchema,
  sep24DepositValidationMiddleware,
  sep24WithdrawValidationMiddleware,
  createSep24ValidationMiddleware,
} from "../../src/schemas/sep24";

describe("SEP-24 Deposit and Withdrawal Parameter Zod Validation Middleware (#807)", () => {
  const validKey = Keypair.random().publicKey();
  const issuerKey = Keypair.random().publicKey();

  describe("validateSep24DepositParams & sep24DepositParamsSchema", () => {
    it("accepts valid deposit parameters with wire snake_case formatting", () => {
      const input = {
        asset_code: "usdc",
        account: validKey,
        amount: "150.50",
        memo: "deposit-memo-1",
        memo_type: "text",
        wallet_name: "stellar-wallet",
        wallet_url: "https://wallet.example.com",
        claimable_balance_supported: "true",
        asset_issuer: issuerKey,
      };

      const parsed = validateSep24DepositParams(input);
      expect(parsed.assetCode).toBe("USDC");
      expect(parsed.account).toBe(validKey);
      expect(parsed.amount).toBe("150.50");
      expect(parsed.memo).toBe("deposit-memo-1");
      expect(parsed.memoType).toBe("text");
      expect(parsed.assetIssuer).toBe(issuerKey);
    });

    it("accepts valid deposit parameters with camelCase formatting", () => {
      const input = {
        assetCode: "xlm",
        account: validKey,
        amount: "50.00",
        memo: "test",
        memoType: "text",
      };

      const parsed = validateSep24DepositParams(input);
      expect(parsed.assetCode).toBe("XLM");
      expect(parsed.account).toBe(validKey);
    });

    it("rejects deposit parameters missing asset_code / assetCode", () => {
      expect(() =>
        validateSep24DepositParams({
          account: validKey,
          amount: "100.00",
        })
      ).toThrow(/asset_code is required/);
    });

    it("rejects deposit parameters with invalid asset_code syntax", () => {
      expect(() =>
        validateSep24DepositParams({
          asset_code: "USDC$$$INVALID",
          account: validKey,
        })
      ).toThrow();
    });

    it("rejects deposit parameters with invalid Stellar account key", () => {
      expect(() =>
        validateSep24DepositParams({
          asset_code: "USDC",
          account: "invalid-public-key-here",
        })
      ).toThrow();
    });

    it("rejects deposit parameters with memo without memo_type", () => {
      expect(() =>
        validateSep24DepositParams({
          asset_code: "USDC",
          memo: "missing-type",
        })
      ).toThrow(/memo_type is required/);
    });

    it("rejects deposit parameters with memo_type without memo", () => {
      expect(() =>
        validateSep24DepositParams({
          asset_code: "USDC",
          memo_type: "text",
        })
      ).toThrow(/memo is required/);
    });

    it("rejects native asset XLM with an asset_issuer", () => {
      expect(() =>
        validateSep24DepositParams({
          asset_code: "XLM",
          asset_issuer: issuerKey,
        })
      ).toThrow(/native asset and does not take an issuer/);
    });

    it("schema alias sep24DepositParametersSchema works identically", () => {
      const parsed = sep24DepositParametersSchema.parse({
        asset_code: "USDC",
        amount: "10.00",
      });
      expect(parsed.assetCode).toBe("USDC");
    });
  });

  describe("validateSep24WithdrawParams & sep24WithdrawParamsSchema", () => {
    it("accepts valid withdrawal parameters with required amount", () => {
      const input = {
        asset_code: "usdc",
        account: validKey,
        amount: "75.25",
        dest: validKey,
        memo: "withdraw-memo",
        memo_type: "text",
        asset_issuer: issuerKey,
      };

      const parsed = validateSep24WithdrawParams(input);
      expect(parsed.assetCode).toBe("USDC");
      expect(parsed.amount).toBe("75.25");
      expect(parsed.dest).toBe(validKey);
      expect(parsed.memo).toBe("withdraw-memo");
      expect(parsed.memoType).toBe("text");
    });

    it("rejects withdrawal parameters missing amount", () => {
      expect(() =>
        validateSep24WithdrawParams({
          asset_code: "USDC",
          account: validKey,
        })
      ).toThrow(/amount is required/);
    });

    it("rejects withdrawal parameters with negative or non-positive amount", () => {
      expect(() =>
        validateSep24WithdrawParams({
          asset_code: "USDC",
          amount: "-50.00",
        })
      ).toThrow();

      expect(() =>
        validateSep24WithdrawParams({
          asset_code: "USDC",
          amount: "0",
        })
      ).toThrow();
    });

    it("rejects withdrawal parameters with invalid dest account", () => {
      expect(() =>
        validateSep24WithdrawParams({
          asset_code: "USDC",
          amount: "10.00",
          dest: "invalid-dest-account",
        })
      ).toThrow();
    });

    it("schema alias sep24WithdrawParametersSchema works identically", () => {
      const parsed = sep24WithdrawParametersSchema.parse({
        asset_code: "USDC",
        amount: "10.00",
      });
      expect(parsed.assetCode).toBe("USDC");
    });
  });

  describe("Fastify Route Validation Middleware integration", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify();
      await app.register(errorHandler);

      // Register deposit test route using sep24DepositValidationMiddleware
      app.post(
        "/test/sep24/deposit",
        {
          preHandler: [sep24DepositValidationMiddleware],
        },
        async (req, reply) => {
          return reply.send({ success: true, body: req.body });
        }
      );

      // Register withdraw test route using sep24WithdrawValidationMiddleware
      app.post(
        "/test/sep24/withdraw",
        {
          preHandler: [sep24WithdrawValidationMiddleware],
        },
        async (req, reply) => {
          return reply.send({ success: true, body: req.body });
        }
      );

      // Register route using factory helper
      app.post(
        "/test/sep24/factory-deposit",
        {
          preHandler: [createSep24ValidationMiddleware("deposit")],
        },
        async (req, reply) => {
          return reply.send({ success: true, body: req.body });
        }
      );

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns 200 OK for valid deposit payload via middleware", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/deposit",
        payload: {
          assetCode: "USDC",
          amount: "100.00",
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
    });

    it("returns 400 Bad Request with VALIDATION_ERROR envelope for missing assetCode on deposit", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/deposit",
        payload: {
          amount: "100.00",
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(json.error.issues)).toBe(true);
      expect(json.error.issues.some((i: any) => i.path.includes("assetCode"))).toBe(true);
    });

    it("returns 400 Bad Request for invalid querystring parameters on deposit", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/deposit?unrecognized_param=123",
        payload: {
          assetCode: "USDC",
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 200 OK for valid withdrawal payload via middleware", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/withdraw",
        payload: {
          assetCode: "USDC",
          amount: "50.00",
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
    });

    it("returns 400 Bad Request for withdrawal missing required amount", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/withdraw",
        payload: {
          assetCode: "USDC",
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.issues.some((i: any) => i.path.includes("amount"))).toBe(true);
    });

    it("returns 400 Bad Request for withdrawal with non-positive amount", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/withdraw",
        payload: {
          assetCode: "USDC",
          amount: "-50.00",
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("factory helper createSep24ValidationMiddleware validates correctly", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/sep24/factory-deposit",
        payload: {
          assetCode: "XLM",
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});

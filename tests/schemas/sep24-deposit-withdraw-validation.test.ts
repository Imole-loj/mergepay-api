import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import {
  validateSep24DepositRequest,
  validateSep24WithdrawalRequest,
  validateSep24InitQuery,
  sep24DepositInitiationSchema,
  sep24WithdrawalInitiationSchema,
  validateSep24Deposit,
  validateSep24Withdraw,
} from "../../src/schemas/sep24";

describe("SEP-24 Deposit and Withdraw Initiation Zod Request Validation (#883)", () => {
  const validKey = Keypair.random().publicKey();

  describe("validateSep24DepositRequest", () => {
    it("accepts valid deposit request payload", () => {
      const validPayload = {
        account: validKey,
        assetCode: "usdc",
        amount: "150.00",
        memo: "memo123",
        memoType: "text",
      };
      const result = validateSep24DepositRequest(validPayload);
      expect(result.account).toBe(validKey);
      expect(result.assetCode).toBe("USDC");
      expect(result.amount).toBe("150.00");
      expect(result.memo).toBe("memo123");
      expect(result.memoType).toBe("text");
    });

    it("rejects payload missing assetCode", () => {
      expect(() =>
        validateSep24DepositRequest({
          account: validKey,
        })
      ).toThrow();
    });

    it("rejects invalid Stellar address for account", () => {
      expect(() =>
        validateSep24DepositRequest({
          account: "invalid-stellar-key",
          assetCode: "USDC",
        })
      ).toThrow();
    });

    it("rejects memo without memoType", () => {
      expect(() =>
        validateSep24DepositRequest({
          account: validKey,
          assetCode: "USDC",
          memo: "orphan_memo",
        })
      ).toThrow(/memoType is required/);
    });

    it("rejects native XLM asset code with an assetIssuer", () => {
      expect(() =>
        validateSep24DepositRequest({
          account: validKey,
          assetCode: "XLM",
          assetIssuer: validKey,
        })
      ).toThrow(/native asset/);
    });
  });

  describe("validateSep24WithdrawalRequest", () => {
    it("accepts valid withdrawal request payload", () => {
      const validPayload = {
        account: validKey,
        assetCode: "xlm",
        amount: "500.25",
      };
      const result = validateSep24WithdrawalRequest(validPayload);
      expect(result.account).toBe(validKey);
      expect(result.assetCode).toBe("XLM");
      expect(result.amount).toBe("500.25");
    });

    it("rejects withdrawal request missing amount", () => {
      expect(() =>
        validateSep24WithdrawalRequest({
          account: validKey,
          assetCode: "USDC",
        })
      ).toThrow();
    });

    it("rejects withdrawal request with negative amount", () => {
      expect(() =>
        validateSep24WithdrawalRequest({
          account: validKey,
          assetCode: "USDC",
          amount: "-10.50",
        })
      ).toThrow();
    });

    it("rejects invalid Stellar public key on withdrawal", () => {
      expect(() =>
        validateSep24WithdrawalRequest({
          account: "not-a-valid-key",
          assetCode: "USDC",
          amount: "10.00",
        })
      ).toThrow();
    });
  });

  describe("validateSep24InitQuery", () => {
    it("accepts valid query string with lang", () => {
      const result = validateSep24InitQuery({ lang: "en" });
      expect(result.lang).toBe("en");
    });

    it("rejects unrecognized query parameters due to strict schema", () => {
      expect(() =>
        validateSep24InitQuery({ unknown_param: "malicious" })
      ).toThrow();
    });
  });

  describe("Combined initiation schemas", () => {
    it("validates sep24DepositInitiationSchema", () => {
      const parsed = sep24DepositInitiationSchema.parse({
        query: { lang: "es" },
        body: {
          account: validKey,
          assetCode: "USDC",
          amount: "25.00",
        },
      });
      expect(parsed.query?.lang).toBe("es");
      expect(parsed.body.assetCode).toBe("USDC");
    });

    it("validates sep24WithdrawalInitiationSchema", () => {
      const parsed = sep24WithdrawalInitiationSchema.parse({
        query: { lang: "fr" },
        body: {
          account: validKey,
          assetCode: "USDC",
          amount: "99.99",
        },
      });
      expect(parsed.query?.lang).toBe("fr");
      expect(parsed.body.amount).toBe("99.99");
    });
  });

  describe("Fastify Route Middleware Integration with Zod 400 responses", () => {
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
        async (req) => {
          const validated = validateSep24DepositRequest(req.body);
          return { ok: true, flow: "deposit", assetCode: validated.assetCode };
        }
      );

      app.post(
        "/api/sep24/withdraw",
        { preHandler: [validateSep24Withdraw] },
        async (req) => {
          const validated = validateSep24WithdrawalRequest(req.body);
          return { ok: true, flow: "withdraw", amount: validated.amount };
        }
      );

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns 200 OK for valid deposit request", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit?lang=en",
        payload: {
          account: validKey,
          assetCode: "usdc",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().assetCode).toBe("USDC");
    });

    it("returns 400 VALIDATION_ERROR with detailed issues for missing assetCode on deposit", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit",
        payload: {
          account: validKey,
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.issues).toBeDefined();
      expect(Array.isArray(body.issues)).toBe(true);
      expect(body.issues.length).toBeGreaterThan(0);
    });

    it("returns 400 VALIDATION_ERROR for invalid Stellar public key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit",
        payload: {
          account: "G_INVALID_KEY",
          assetCode: "USDC",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });

    it("returns 200 OK for valid withdrawal request", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/withdraw",
        payload: {
          account: validKey,
          assetCode: "USDC",
          amount: "100.00",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().amount).toBe("100.00");
    });

    it("returns 400 VALIDATION_ERROR when withdrawal amount is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/withdraw",
        payload: {
          account: validKey,
          assetCode: "USDC",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });
  });
});

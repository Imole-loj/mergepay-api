import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import {
  validateSep24Deposit,
  validateSep24Withdraw,
  sep24DepositValidationMiddleware,
  sep24WithdrawValidationMiddleware,
  validateSep24DepositRequest,
  validateSep24WithdrawalRequest,
  validateSep24InitQuery,
  sep24DepositInitiationSchema,
  sep24WithdrawalInitiationSchema,
} from "../../src/schemas/sep24";

describe("SEP-24 Deposit and Withdrawal Zod Request Validation Middleware (#867)", () => {
  const validKey = Keypair.random().publicKey();
  const anotherKey = Keypair.random().publicKey();

  describe("Fastify Route Middleware Integration — 400 Bad Request responses", () => {
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
        "/api/v1/sep24/deposit",
        { preHandler: [sep24DepositValidationMiddleware] },
        async (req) => {
          const body = req.body as any;
          return { ok: true, flow: "deposit", assetCode: body.assetCode };
        }
      );

      app.post(
        "/api/v1/sep24/withdraw",
        { preHandler: [sep24WithdrawValidationMiddleware] },
        async (req) => {
          const body = req.body as any;
          return { ok: true, flow: "withdraw", amount: body.amount, assetCode: body.assetCode };
        }
      );

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    describe("POST /api/v1/sep24/deposit", () => {
      it("returns 200 OK and canonicalizes assetCode to upper case for a valid payload", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/deposit?lang=en",
          payload: {
            account: validKey,
            assetCode: "usdc",
            amount: "100.50",
            memo: "invoice-42",
            memoType: "text",
          },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, flow: "deposit", assetCode: "USDC" });
      });

      it("returns 400 VALIDATION_ERROR when assetCode is missing", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/deposit",
          payload: {
            account: validKey,
          },
        });
        expect(res.statusCode).toBe(400);
        const data = res.json();
        expect(data.error).toBe("VALIDATION_ERROR");
        expect(data.issues.some((i: any) => i.path.includes("assetCode"))).toBe(true);
      });

      it("returns 400 VALIDATION_ERROR when assetCode is empty or invalid format", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/deposit",
          payload: {
            account: validKey,
            assetCode: "USDC$$",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("VALIDATION_ERROR");
      });

      it("returns 400 VALIDATION_ERROR when account has invalid Stellar address", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/deposit",
          payload: {
            account: "G_NOT_A_VALID_STELLAR_KEY",
            assetCode: "USDC",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("VALIDATION_ERROR");
      });

      it("returns 400 VALIDATION_ERROR when memo is provided without memoType", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/deposit",
          payload: {
            account: validKey,
            assetCode: "USDC",
            memo: "orphan_memo_test",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("VALIDATION_ERROR");
      });

      it("returns 400 VALIDATION_ERROR when native XLM asset specifies an assetIssuer", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/deposit",
          payload: {
            account: validKey,
            assetCode: "XLM",
            assetIssuer: anotherKey,
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("VALIDATION_ERROR");
      });

      it("returns 400 VALIDATION_ERROR when unexpected body fields are included (strict schema)", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/deposit",
          payload: {
            account: validKey,
            assetCode: "USDC",
            malicious_injection: true,
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("VALIDATION_ERROR");
      });

      it("returns 400 VALIDATION_ERROR when unknown query parameters are passed", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/deposit?asset_code=USDC",
          payload: {
            account: validKey,
            assetCode: "USDC",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("VALIDATION_ERROR");
      });
    });

    describe("POST /api/v1/sep24/withdraw", () => {
      it("returns 200 OK for valid withdrawal payload", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/withdraw",
          payload: {
            account: validKey,
            assetCode: "usdc",
            amount: "250.75",
          },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, flow: "withdraw", amount: "250.75", assetCode: "USDC" });
      });

      it("returns 400 VALIDATION_ERROR when amount is missing", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/withdraw",
          payload: {
            account: validKey,
            assetCode: "USDC",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("VALIDATION_ERROR");
      });

      it("returns 400 VALIDATION_ERROR when amount is negative or non-numeric", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/withdraw",
          payload: {
            account: validKey,
            assetCode: "USDC",
            amount: "-50.00",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("VALIDATION_ERROR");
      });

      it("returns 400 VALIDATION_ERROR when amount exceeds 7 decimal places", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/withdraw",
          payload: {
            account: validKey,
            assetCode: "USDC",
            amount: "10.12345678",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("VALIDATION_ERROR");
      });

      it("returns 400 VALIDATION_ERROR when account is malformed", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/sep24/withdraw",
          payload: {
            account: "bad_stellar_address",
            assetCode: "USDC",
            amount: "10.00",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("VALIDATION_ERROR");
      });
    });
  });

  describe("SEP-24 Schema Validation Unit Helpers", () => {
    it("validateSep24DepositRequest parses valid payload", () => {
      const res = validateSep24DepositRequest({
        account: validKey,
        assetCode: "srt",
        amount: "5.00",
      });
      expect(res.assetCode).toBe("SRT");
      expect(res.account).toBe(validKey);
    });

    it("validateSep24WithdrawalRequest parses valid withdrawal payload", () => {
      const res = validateSep24WithdrawalRequest({
        account: validKey,
        assetCode: "xlm",
        amount: "100.0000000",
      });
      expect(res.assetCode).toBe("XLM");
      expect(res.amount).toBe("100.0000000");
    });

    it("validateSep24InitQuery parses query with lang", () => {
      const res = validateSep24InitQuery({ lang: "fr" });
      expect(res.lang).toBe("fr");
    });

    it("sep24DepositInitiationSchema validates query and body together", () => {
      const res = sep24DepositInitiationSchema.parse({
        query: { lang: "de" },
        body: { account: validKey, assetCode: "USDC" },
      });
      expect(res.query?.lang).toBe("de");
      expect(res.body.assetCode).toBe("USDC");
    });

    it("sep24WithdrawalInitiationSchema validates query and body together", () => {
      const res = sep24WithdrawalInitiationSchema.parse({
        query: { lang: "en" },
        body: { account: validKey, assetCode: "USDC", amount: "50.00" },
      });
      expect(res.query?.lang).toBe("en");
      expect(res.body.amount).toBe("50.00");
    });
  });
});

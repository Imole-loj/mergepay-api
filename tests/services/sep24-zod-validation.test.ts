import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import {
  sep24DepositRequestSchema,
  sep24WithdrawRequestSchema,
  sep24InitQuerySchema,
  sep24CallbackQuerySchema,
  sep24LangSchema,
  sep24TransactionQuerySchema,
  sep24TransactionsQuerySchema,
} from "../../src/validations/sep24";

describe("SEP-24 Zod Request Validation (#907)", () => {
  const validKey = Keypair.random().publicKey();

  describe("sep24DepositRequestSchema", () => {
    it("accepts a minimal valid deposit payload with assetCode and account", () => {
      const valid = {
        assetCode: "USDC",
        account: validKey,
      };
      const parsed = sep24DepositRequestSchema.parse(valid);
      expect(parsed.assetCode).toBe("USDC");
      expect(parsed.account).toBe(validKey);
    });

    it("uppercases assetCode automatically", () => {
      const parsed = sep24DepositRequestSchema.parse({
        assetCode: "usdc",
        account: validKey,
      });
      expect(parsed.assetCode).toBe("USDC");
    });

    it("accepts optional amount and paired memo/memoType", () => {
      const parsed = sep24DepositRequestSchema.parse({
        assetCode: "XLM",
        account: validKey,
        amount: "100.50",
        memo: "deposit-memo-1",
        memoType: "text",
      });
      expect(parsed.amount).toBe("100.50");
      expect(parsed.memo).toBe("deposit-memo-1");
      expect(parsed.memoType).toBe("text");
    });

    it("rejects an invalid Stellar public key for account", () => {
      expect(() =>
        sep24DepositRequestSchema.parse({
          assetCode: "USDC",
          account: "not-a-valid-stellar-key",
        })
      ).toThrow();
    });

    it("rejects memo without memoType", () => {
      expect(() =>
        sep24DepositRequestSchema.parse({
          assetCode: "USDC",
          account: validKey,
          memo: "orphan-memo",
        })
      ).toThrow(/memoType is required when memo is supplied/);
    });

    it("rejects XLM with an assetIssuer", () => {
      expect(() =>
        sep24DepositRequestSchema.parse({
          assetCode: "XLM",
          assetIssuer: validKey,
        })
      ).toThrow(/XLM is a native asset/);
    });

    it("rejects an empty assetCode", () => {
      expect(() =>
        sep24DepositRequestSchema.parse({
          assetCode: "",
          account: validKey,
        })
      ).toThrow();
    });

    it("rejects an assetCode longer than 12 characters", () => {
      expect(() =>
        sep24DepositRequestSchema.parse({
          assetCode: "VERYLONGASSETCODE",
          account: validKey,
        })
      ).toThrow();
    });

    it("rejects non-numeric amount", () => {
      expect(() =>
        sep24DepositRequestSchema.parse({
          assetCode: "USDC",
          account: validKey,
          amount: "invalid-amount",
        })
      ).toThrow();
    });

    it("rejects negative amount", () => {
      expect(() =>
        sep24DepositRequestSchema.parse({
          assetCode: "USDC",
          account: validKey,
          amount: "-50.00",
        })
      ).toThrow();
    });

    it("rejects unknown properties in strict mode", () => {
      expect(() =>
        sep24DepositRequestSchema.parse({
          assetCode: "USDC",
          account: validKey,
          injectedProp: "hack",
        })
      ).toThrow();
    });
  });

  describe("sep24WithdrawRequestSchema", () => {
    it("accepts a valid withdrawal payload with amount", () => {
      const valid = {
        assetCode: "USDC",
        account: validKey,
        amount: "500.00",
      };
      const parsed = sep24WithdrawRequestSchema.parse(valid);
      expect(parsed.assetCode).toBe("USDC");
      expect(parsed.account).toBe(validKey);
      expect(parsed.amount).toBe("500.00");
    });

    it("rejects missing amount on withdrawal", () => {
      expect(() =>
        sep24WithdrawRequestSchema.parse({
          assetCode: "USDC",
          account: validKey,
        })
      ).toThrow();
    });

    it("rejects missing assetCode", () => {
      expect(() =>
        sep24WithdrawRequestSchema.parse({
          account: validKey,
          amount: "10.00",
        })
      ).toThrow();
    });

    it("accepts refundAddress and paired refundMemo/refundMemoType", () => {
      const parsed = sep24WithdrawRequestSchema.parse({
        assetCode: "USDC",
        account: validKey,
        amount: "100.00",
        refundAddress: validKey,
        refundMemo: "refund-1",
        refundMemoType: "text",
      });
      expect(parsed.refundAddress).toBe(validKey);
      expect(parsed.refundMemo).toBe("refund-1");
      expect(parsed.refundMemoType).toBe("text");
    });
  });

  describe("Query parameter schemas", () => {
    it("sep24InitQuerySchema rejects unknown query parameters", () => {
      expect(() =>
        sep24InitQuerySchema.parse({ unexpected: "param" })
      ).toThrow();
    });

    it("sep24InitQuerySchema accepts an empty query object", () => {
      expect(() => sep24InitQuerySchema.parse({})).not.toThrow();
    });

    it("sep24CallbackQuerySchema accepts valid lang parameter", () => {
      const parsed = sep24CallbackQuerySchema.parse({ lang: "en-US" });
      expect(parsed.lang).toBe("en-US");
    });

    it("sep24CallbackQuerySchema rejects unknown parameters in strict mode", () => {
      expect(() =>
        sep24CallbackQuerySchema.parse({ lang: "en", extra: "forbidden" })
      ).toThrow();
    });

    it("sep24TransactionQuerySchema accepts valid transaction lookup params", () => {
      const parsed = sep24TransactionQuerySchema.parse({
        id: "tx-uuid-12345",
      });
      expect(parsed.id).toBe("tx-uuid-12345");
    });

    it("sep24TransactionsQuerySchema accepts pagination and kind filter", () => {
      const parsed = sep24TransactionsQuerySchema.parse({
        kind: "deposit",
        limit: 10,
        order: "desc",
      });
      expect(parsed.kind).toBe("deposit");
      expect(parsed.limit).toBe(10);
      expect(parsed.order).toBe("desc");
    });
  });

  describe("sep24LangSchema", () => {
    it("accepts valid ISO language codes", () => {
      expect(sep24LangSchema.parse("en")).toBe("en");
      expect(sep24LangSchema.parse("fr-CA")).toBe("fr-CA");
      expect(sep24LangSchema.parse("es-419")).toBe("es-419");
    });

    it("rejects single character language strings", () => {
      expect(() => sep24LangSchema.parse("e")).toThrow();
    });

    it("rejects strings exceeding 10 characters", () => {
      expect(() => sep24LangSchema.parse("english-american-dialect")).toThrow();
    });
  });
});

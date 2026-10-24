import { describe, it, expect } from "vitest";
import {
  sep24InteractiveDepositCallbackParamsSchema,
  sep24InteractiveWithdrawalCallbackParamsSchema,
  validateSep24InteractiveCallbackParams,
} from "../../src/schemas/sep24";
import { ZodError } from "zod";

describe("SEP-24 Interactive Deposit and Withdrawal Callback Parameters Schema (#891)", () => {
  const validStellarTxHash = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

  describe("sep24InteractiveDepositCallbackParamsSchema", () => {
    it("accepts a valid deposit callback payload", () => {
      const payload = {
        id: "dep_tx_12345",
        status: "completed",
        kind: "deposit" as const,
        amount_in: "100.0000000",
        amount_fee: "0.5000000",
        stellar_transaction_id: validStellarTxHash,
        external_transaction_id: "ext_bank_ref_789",
        message: "Deposit confirmed successfully",
      };

      const parsed = sep24InteractiveDepositCallbackParamsSchema.parse(payload);
      expect(parsed).toMatchObject(payload);
    });

    it("accepts nested transaction envelope shape", () => {
      const payload = {
        transaction: {
          id: "nested_dep_999",
          status: "pending_anchor",
          amount_in: "50.0000000",
        },
      };

      const parsed = sep24InteractiveDepositCallbackParamsSchema.parse(payload);
      expect(parsed.transaction?.id).toBe("nested_dep_999");
      expect(parsed.transaction?.status).toBe("pending_anchor");
    });

    it("rejects invalid stellar transaction hash format", () => {
      const payload = {
        id: "dep_tx_bad_hash",
        status: "completed",
        stellar_transaction_id: "invalid-short-hash",
      };

      expect(() =>
        sep24InteractiveDepositCallbackParamsSchema.parse(payload)
      ).toThrow(ZodError);
    });

    it("rejects mismatched kind on deposit callback", () => {
      const payload = {
        id: "dep_tx_1",
        status: "completed",
        kind: "withdrawal", // Mismatched kind
      };

      expect(() =>
        sep24InteractiveDepositCallbackParamsSchema.parse(payload)
      ).toThrow(ZodError);
    });
  });

  describe("sep24InteractiveWithdrawalCallbackParamsSchema", () => {
    it("accepts a valid withdrawal callback payload", () => {
      const payload = {
        id: "wth_tx_67890",
        status: "pending_user_transfer_start",
        kind: "withdrawal" as const,
        amount_out: "250.0000000",
        amount_fee: "1.0000000",
        stellar_transaction_id: validStellarTxHash,
        message: "Waiting for user transfer",
      };

      const parsed = sep24InteractiveWithdrawalCallbackParamsSchema.parse(payload);
      expect(parsed).toMatchObject(payload);
    });

    it("rejects mismatched kind on withdrawal callback", () => {
      const payload = {
        id: "wth_tx_1",
        status: "completed",
        kind: "deposit", // Mismatched kind
      };

      expect(() =>
        sep24InteractiveWithdrawalCallbackParamsSchema.parse(payload)
      ).toThrow(ZodError);
    });
  });

  describe("validateSep24InteractiveCallbackParams helper", () => {
    it("routes to deposit schema when kind is 'deposit'", () => {
      const payload = {
        id: "dep_123",
        status: "completed",
        kind: "deposit",
      };

      const res = validateSep24InteractiveCallbackParams(payload, "deposit");
      expect(res).toMatchObject(payload);
    });

    it("routes to withdrawal schema when kind is 'withdrawal'", () => {
      const payload = {
        id: "wth_456",
        status: "completed",
        kind: "withdrawal",
      };

      const res = validateSep24InteractiveCallbackParams(payload, "withdrawal");
      expect(res).toMatchObject(payload);
    });

    it("falls back to canonical sep24CallbackSchema when kind is omitted", () => {
      const payload = {
        id: "tx_generic_789",
        status: "completed",
      };

      const res = validateSep24InteractiveCallbackParams(payload);
      expect(res.externalTransactionId).toBe("tx_generic_789");
      expect(res.rawStatus).toBe("completed");
    });
  });
});

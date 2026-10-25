import { describe, it, expect } from "vitest";
import {
  splitExpense,
  EXPENSE_CALCULATION_ERROR_CODES,
  isExpenseCalculationError,
  type SplitParticipant,
} from "../../src/services/expense-calculation";
import {
  computeShares,
  SETTLEMENT_ENGINE_ERROR_CODES,
  isSettlementEngineError,
  type ShareInput,
} from "../../src/services/settlement";
import { toStroops, fromStroops } from "../../src/services/money";

describe("Group Expense Split Calculation Edge Cases (#871)", () => {
  function sumStroopsFromShares(shares: { amount?: string; shareAmount?: string }[]): bigint {
    return shares.reduce((acc, s) => {
      const val = s.amount ?? s.shareAmount ?? "0";
      return acc + toStroops(val);
    }, 0n);
  }

  describe("Sub-Stroop & Fractional Cent Residual Distribution", () => {
    it("distributes 1 stroop (0.0000001) losslessly among 3 participants", () => {
      const participants: SplitParticipant[] = [
        { userId: "user-1" },
        { userId: "user-2" },
        { userId: "user-3" },
      ];

      const result = splitExpense("0.0000001", "equal", participants);
      expect(result.shares).toHaveLength(3);
      expect(sumStroopsFromShares(result.shares)).toBe(toStroops("0.0000001"));

      const nonZero = result.shares.filter((s) => s.amount !== "0.0000000" && s.amount !== "0");
      expect(nonZero).toHaveLength(1);
      expect(nonZero[0].amount).toBe("0.0000001");
    });

    it("distributes 2 stroops (0.0000002) among 5 participants without creating or destroying value", () => {
      const participants: SplitParticipant[] = [
        { userId: "u1" },
        { userId: "u2" },
        { userId: "u3" },
        { userId: "u4" },
        { userId: "u5" },
      ];

      const result = splitExpense("0.0000002", "equal", participants);
      expect(sumStroopsFromShares(result.shares)).toBe(toStroops("0.0000002"));

      const allocated = result.shares.filter((s) => s.amount === "0.0000001");
      const zeroed = result.shares.filter((s) => s.amount === "0" || s.amount === "0.0000000");
      expect(allocated).toHaveLength(2);
      expect(zeroed).toHaveLength(3);
    });

    it("distributes prime stroop total (0.0000007) across 4 participants", () => {
      const participants: SplitParticipant[] = [
        { userId: "p1" },
        { userId: "p2" },
        { userId: "p3" },
        { userId: "p4" },
      ];

      const result = splitExpense("0.0000007", "equal", participants);
      expect(sumStroopsFromShares(result.shares)).toBe(toStroops("0.0000007"));
      // 7 stroops / 4 = 1 stroop each (4 stroops) + 3 remainder stroops
      // First 3 get 2 stroops (0.0000002), 4th gets 1 stroop (0.0000001)
      expect(result.shares[0].amount).toBe("0.0000002");
      expect(result.shares[1].amount).toBe("0.0000002");
      expect(result.shares[2].amount).toBe("0.0000002");
      expect(result.shares[3].amount).toBe("0.0000001");
    });
  });

  describe("Large Participant Counts & Exact Sum Invariant", () => {
    it("handles 100 participants on an uneven amount (33.3333333 XLM)", () => {
      const count = 100;
      const totalAmount = "33.3333333";
      const participants: SplitParticipant[] = Array.from({ length: count }, (_, i) => ({
        userId: `member-${i + 1}`,
      }));

      const result = splitExpense(totalAmount, "equal", participants);
      expect(result.shares).toHaveLength(count);
      expect(sumStroopsFromShares(result.shares)).toBe(toStroops(totalAmount));
    });

    it("handles 250 participants splitting 1000.0000001 XLM without precision loss", () => {
      const count = 250;
      const totalAmount = "1000.0000001";
      const participants: SplitParticipant[] = Array.from({ length: count }, (_, i) => ({
        userId: `member-${i + 1}`,
      }));

      const result = splitExpense(totalAmount, "equal", participants);
      expect(result.shares).toHaveLength(count);
      expect(sumStroopsFromShares(result.shares)).toBe(toStroops(totalAmount));
    });

    it("settlement computeShares matches exact total for 100 participants", () => {
      const count = 100;
      const totalAmount = "99.9999999";
      const sharesInput: ShareInput[] = Array.from({ length: count }, (_, i) => ({
        userId: `u-${i + 1}`,
      }));

      const shares = computeShares(totalAmount, "equal", sharesInput);
      expect(shares).toHaveLength(count);
      expect(sumStroopsFromShares(shares)).toBe(toStroops(totalAmount));
    });
  });

  describe("Uneven Percentage Splits with High Precision", () => {
    it("splits 100 XLM across 3 participants with recurring decimal percentages", () => {
      const participants: SplitParticipant[] = [
        { userId: "u1", percent: "33.333333" },
        { userId: "u2", percent: "33.333333" },
        { userId: "u3", percent: "33.333334" },
      ];

      const result = splitExpense("100", "percentage", participants);
      expect(sumStroopsFromShares(result.shares)).toBe(toStroops("100"));
    });

    it("splits 50 XLM across 7 participants with 6 decimal place percentages summing to 100", () => {
      const participants: SplitParticipant[] = [
        { userId: "p1", percent: "14.285714" },
        { userId: "p2", percent: "14.285714" },
        { userId: "p3", percent: "14.285714" },
        { userId: "p4", percent: "14.285714" },
        { userId: "p5", percent: "14.285714" },
        { userId: "p6", percent: "14.285714" },
        { userId: "p7", percent: "14.285716" }, // Sums to exactly 100.000000
      ];

      const result = splitExpense("50", "percentage", participants);
      expect(sumStroopsFromShares(result.shares)).toBe(toStroops("50"));
    });

    it("rejects percentage split when percentages sum to 99.999999 or 100.000001", () => {
      const underParticipants: SplitParticipant[] = [
        { userId: "u1", percent: "50" },
        { userId: "u2", percent: "49.999999" },
      ];

      expect(() => splitExpense("100", "percentage", underParticipants)).toThrow();

      const overParticipants: SplitParticipant[] = [
        { userId: "u1", percent: "50" },
        { userId: "u2", percent: "50.000001" },
      ];

      expect(() => splitExpense("100", "percentage", overParticipants)).toThrow();
    });
  });

  describe("Custom Split Edge Cases & Zero Amount Handling", () => {
    it("permits zero-amount shares in custom split when sum equals total", () => {
      const participants: SplitParticipant[] = [
        { userId: "payer", amount: "25.5000000" },
        { userId: "observer", amount: "0.0000000" },
        { userId: "debtor", amount: "10.0000000" },
      ];

      const result = splitExpense("35.5000000", "custom", participants);
      expect(result.shares).toHaveLength(3);
      expect(sumStroopsFromShares(result.shares)).toBe(toStroops("35.5000000"));
      expect(result.shares.find((s) => s.userId === "observer")?.amount).toBe("0");
    });

    it("rejects custom split deviating by even a single stroop (0.0000001)", () => {
      const participants: SplitParticipant[] = [
        { userId: "u1", amount: "10.0000000" },
        { userId: "u2", amount: "10.0000001" },
      ];

      expect(() => splitExpense("20.0000000", "custom", participants)).toThrow();
    });

    it("computeShares in settlement engine permits custom split matching exact total", () => {
      const shares: ShareInput[] = [
        { userId: "u1", amount: "15.1234567" },
        { userId: "u2", amount: "0.0000000" },
        { userId: "u3", amount: "5.0000000" },
      ];

      const computed = computeShares("20.1234567", "custom", shares);
      expect(sumStroopsFromShares(computed)).toBe(toStroops("20.1234567"));
    });
  });

  describe("Boundary Conditions & Invalid Inputs", () => {
    it("handles large values near Stellar ledger max amount", () => {
      const maxLedgerAmount = "922337203685.4775807";
      const participants: SplitParticipant[] = [
        { userId: "a" },
        { userId: "b" },
        { userId: "c" },
      ];

      const result = splitExpense(maxLedgerAmount, "equal", participants);
      expect(sumStroopsFromShares(result.shares)).toBe(toStroops(maxLedgerAmount));
    });

    it("rejects zero amount total", () => {
      const participants: SplitParticipant[] = [{ userId: "a" }, { userId: "b" }];
      expect(() => splitExpense("0", "equal", participants)).toThrow();
      expect(() => splitExpense("0.0000000", "equal", participants)).toThrow();
    });

    it("rejects negative amounts", () => {
      const participants: SplitParticipant[] = [{ userId: "a" }];
      expect(() => splitExpense("-10", "equal", participants)).toThrow();
      expect(() => splitExpense("-0.0000001", "equal", participants)).toThrow();
    });

    it("rejects empty participants list", () => {
      expect(() => splitExpense("100", "equal", [])).toThrow();
      expect(() => computeShares("100", "equal", [])).toThrow();
    });

    it("rejects duplicate participant user IDs", () => {
      const participants: SplitParticipant[] = [
        { userId: "alice" },
        { userId: "alice" },
      ];
      expect(() => splitExpense("50", "equal", participants)).toThrow();
    });

    it("normalizes different decimal format representations consistently", () => {
      const p1: SplitParticipant[] = [{ userId: "a" }, { userId: "b" }];
      const r1 = splitExpense("10", "equal", p1);
      const r2 = splitExpense("10.0", "equal", p1);
      const r3 = splitExpense("10.0000000", "equal", p1);

      expect(sumStroopsFromShares(r1.shares)).toBe(toStroops("10"));
      expect(sumStroopsFromShares(r2.shares)).toBe(toStroops("10"));
      expect(sumStroopsFromShares(r3.shares)).toBe(toStroops("10"));
    });
  });
});

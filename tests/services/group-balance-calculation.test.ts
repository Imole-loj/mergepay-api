import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeMultiCurrencyBalancesAndSimplifications,
  calculateAndAuditGroupBalances,
  type MultiCurrencySettlementSummary,
} from "../../src/services/group-balances";
import type {
  AssetBalanceShareRow,
  AssetBalanceSettlementRow,
} from "../../src/services/settlement";

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const XLM = { assetCode: "XLM", assetIssuer: null };
const USDC = { assetCode: "USDC", assetIssuer: USDC_ISSUER };

vi.mock("../../src/db", () => {
  const model = () => ({
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  });
  return {
    prisma: {
      expense: model(),
      settlement: model(),
      auditLog: model(),
    },
  };
});

vi.mock("../../src/services/audit", () => ({
  audit: vi.fn(async () => {}),
}));

import { audit } from "../../src/services/audit";
import { prisma } from "../../src/db";

describe("Multi-Currency Group Expense Balance Calculation (#893)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("computeMultiCurrencyBalancesAndSimplifications", () => {
    it("segregates XLM and USDC balances and generates independent settlement suggestions", () => {
      // Alice pays 60 XLM for Bob and Charlie (equal: 20 each)
      // Charlie pays 90 USDC for Alice and Bob (equal: 30 each)
      const shares: AssetBalanceShareRow[] = [
        {
          payerUserId: "user_alice",
          userId: "user_bob",
          shareAmount: "20.0000000",
          settled: false,
          ...XLM,
        },
        {
          payerUserId: "user_alice",
          userId: "user_charlie",
          shareAmount: "20.0000000",
          settled: false,
          ...XLM,
        },
        {
          payerUserId: "user_charlie",
          userId: "user_alice",
          shareAmount: "30.0000000",
          settled: false,
          ...USDC,
        },
        {
          payerUserId: "user_charlie",
          userId: "user_bob",
          shareAmount: "30.0000000",
          settled: false,
          ...USDC,
        },
      ];

      const settlements: AssetBalanceSettlementRow[] = [];

      const result = computeMultiCurrencyBalancesAndSimplifications(shares, settlements);

      expect(result).toHaveLength(2);

      const xlmResult = result.find((r) => r.assetCode === "XLM");
      const usdcResult = result.find((r) => r.assetCode === "USDC");

      expect(xlmResult).toBeDefined();
      expect(usdcResult).toBeDefined();

      // XLM Balances
      const xlmMap = Object.fromEntries(xlmResult!.balances.map((b) => [b.userId, b.net]));
      expect(xlmMap["user_alice"]).toBe("40");
      expect(xlmMap["user_bob"]).toBe("-20");
      expect(xlmMap["user_charlie"]).toBe("-20");

      // XLM Suggestions: Bob -> Alice (20), Charlie -> Alice (20)
      expect(xlmResult!.suggestions).toHaveLength(2);
      expect(xlmResult!.suggestions).toEqual(
        expect.arrayContaining([
          { fromUserId: "user_bob", toUserId: "user_alice", amount: "20" },
          { fromUserId: "user_charlie", toUserId: "user_alice", amount: "20" },
        ])
      );

      // USDC Balances
      const usdcMap = Object.fromEntries(usdcResult!.balances.map((b) => [b.userId, b.net]));
      expect(usdcMap["user_charlie"]).toBe("60");
      expect(usdcMap["user_alice"]).toBe("-30");
      expect(usdcMap["user_bob"]).toBe("-30");

      // USDC Suggestions: Alice -> Charlie (30), Bob -> Charlie (30)
      expect(usdcResult!.suggestions).toHaveLength(2);
      expect(usdcResult!.suggestions).toEqual(
        expect.arrayContaining([
          { fromUserId: "user_alice", toUserId: "user_charlie", amount: "30" },
          { fromUserId: "user_bob", toUserId: "user_charlie", amount: "30" },
        ])
      );
    });

    it("simplifies circular debts to zero within the same asset", () => {
      // Alice pays 30 XLM for Bob
      // Bob pays 30 XLM for Charlie
      // Charlie pays 30 XLM for Alice
      const shares: AssetBalanceShareRow[] = [
        {
          payerUserId: "user_alice",
          userId: "user_bob",
          shareAmount: "30.0000000",
          settled: false,
          ...XLM,
        },
        {
          payerUserId: "user_bob",
          userId: "user_charlie",
          shareAmount: "30.0000000",
          settled: false,
          ...XLM,
        },
        {
          payerUserId: "user_charlie",
          userId: "user_alice",
          shareAmount: "30.0000000",
          settled: false,
          ...XLM,
        },
      ];

      const result = computeMultiCurrencyBalancesAndSimplifications(shares, []);
      expect(result).toHaveLength(1);
      const xlmResult = result[0];

      // Net of each is 0
      for (const balance of xlmResult.balances) {
        expect(balance.net).toBe("0");
      }
      // Suggestions must be empty because net debt is zero
      expect(xlmResult.suggestions).toHaveLength(0);
    });

    it("applies confirmed settlements to reduce net debt accurately", () => {
      const shares: AssetBalanceShareRow[] = [
        {
          payerUserId: "user_alice",
          userId: "user_bob",
          shareAmount: "50.0000000",
          settled: false,
          ...USDC,
        },
      ];

      // Bob makes a confirmed settlement of 20 USDC to Alice
      const settlements: AssetBalanceSettlementRow[] = [
        {
          fromUserId: "user_bob",
          toUserId: "user_alice",
          amount: "20.0000000",
          confirmed: true,
          ...USDC,
        },
      ];

      const result = computeMultiCurrencyBalancesAndSimplifications(shares, settlements);
      expect(result).toHaveLength(1);

      const usdcMap = Object.fromEntries(result[0].balances.map((b) => [b.userId, b.net]));
      expect(usdcMap["user_alice"]).toBe("30");
      expect(usdcMap["user_bob"]).toBe("-30");

      expect(result[0].suggestions).toEqual([
        { fromUserId: "user_bob", toUserId: "user_alice", amount: "30" },
      ]);
    });

    it("ignores unconfirmed settlements when calculating debt", () => {
      const shares: AssetBalanceShareRow[] = [
        {
          payerUserId: "user_alice",
          userId: "user_bob",
          shareAmount: "50.0000000",
          settled: false,
          ...XLM,
        },
      ];

      const settlements: AssetBalanceSettlementRow[] = [
        {
          fromUserId: "user_bob",
          toUserId: "user_alice",
          amount: "50.0000000",
          confirmed: false, // Pending settlement
          ...XLM,
        },
      ];

      const result = computeMultiCurrencyBalancesAndSimplifications(shares, settlements);
      const xlmMap = Object.fromEntries(result[0].balances.map((b) => [b.userId, b.net]));
      expect(xlmMap["user_alice"]).toBe("50");
      expect(xlmMap["user_bob"]).toBe("-50");
    });
  });

  describe("calculateAndAuditGroupBalances", () => {
    it("audits group balance calculation when actor is provided", async () => {
      vi.mocked(prisma.expense.findMany).mockResolvedValue([
        {
          id: "exp_1",
          groupId: "grp_100",
          payerUserId: "user_alice",
          assetCode: "XLM",
          assetIssuer: null,
          shares: [
            {
              id: "sh_1",
              expenseId: "exp_1",
              userId: "user_bob",
              shareAmount: "25.0000000",
              status: "pending",
            },
          ],
        } as any,
      ]);

      vi.mocked(prisma.settlement.findMany).mockResolvedValue([]);

      const summary: MultiCurrencySettlementSummary = await calculateAndAuditGroupBalances(
        "grp_100",
        { type: "user", id: "user_alice", publicKey: "GALICE123" }
      );

      expect(summary.groupId).toBe("grp_100");
      expect(summary.assetBalances).toHaveLength(1);
      expect(summary.assetBalances[0].assetCode).toBe("XLM");

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "group.balances_calculated",
          actorType: "user",
          userId: "user_alice",
          actorPublicKey: "GALICE123",
          entityType: "group",
          entityId: "grp_100",
          groupId: "grp_100",
          outcome: "success",
          metadata: expect.objectContaining({
            assetCount: 1,
            assets: ["XLM"],
          }),
        })
      );
    });

    it("does not fail or write audit log when actor is omitted", async () => {
      vi.mocked(prisma.expense.findMany).mockResolvedValue([]);
      vi.mocked(prisma.settlement.findMany).mockResolvedValue([]);

      const summary = await calculateAndAuditGroupBalances("grp_200");
      expect(summary.groupId).toBe("grp_200");
      expect(summary.assetBalances).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });
  });
});

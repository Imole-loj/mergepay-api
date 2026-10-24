import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    settlement: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    treasuryTransaction: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return {
    prisma,
    getTransaction: vi.fn(),
    verifyTransactionMemo: vi.fn(),
    getTransactionPayments: vi.fn(),
    verifyPaymentOperation: vi.fn(),
    reconcileSingleSettlement: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/stellar", () => ({
  stellar: { getTransaction: h.getTransaction },
}));
vi.mock("../../src/services/horizonService", () => ({
  verifyTransactionMemo: h.verifyTransactionMemo,
  getTransactionPayments: h.getTransactionPayments,
  verifyPaymentOperation: h.verifyPaymentOperation,
}));
vi.mock("../../src/services/settlement-reconciliation", () => ({
  RECONCILIATION_MAX_RETRIES: 10,
  reconcileSingleSettlement: h.reconcileSingleSettlement,
}));
vi.mock("../../src/services/audit", () => ({ audit: h.audit }));

import {
  STATUS_SYNC_MIN_AGE_MS,
  syncPendingTransactionStatuses,
} from "../../src/worker/tasks/tx-status-sync";

const NOW = new Date("2026-06-01T00:10:00.000Z");
const NO_DELAY = async (): Promise<void> => {};
const deps = { delay: NO_DELAY };

describe("Background Job Worker - Pending Stellar Transaction Monitoring (#886)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.prisma.settlement.findMany.mockResolvedValue([]);
    h.prisma.treasuryTransaction.findMany.mockResolvedValue([]);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.treasuryTransaction.updateMany.mockResolvedValue({ count: 1 });
  });

  describe("Settlement Status Monitoring", () => {
    it("updates pending settlement to confirmed when transaction succeeds on-chain", async () => {
      const mockSettlement = {
        id: "settle_101",
        groupId: "group_101",
        shortCode: "MP101",
        stellarTxHash: "tx_hash_success",
        retryCount: 0,
        amount: "50.00",
        assetCode: "XLM",
        assetIssuer: null,
        expenseId: "exp_101",
        status: "verifying",
        updatedAt: new Date(NOW.getTime() - STATUS_SYNC_MIN_AGE_MS - 5000),
        to: { stellarPublicKey: "GDESTINATION" },
      };

      h.prisma.settlement.findMany.mockResolvedValue([mockSettlement]);
      h.reconcileSingleSettlement.mockResolvedValue("confirmed");

      const summary = await syncPendingTransactionStatuses(NOW, deps);

      expect(h.reconcileSingleSettlement).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "settle_101",
          stellarTxHash: "tx_hash_success",
        }),
        expect.any(Number),
        expect.any(Object)
      );
      expect(summary.confirmed).toBe(1);
    });

    it("updates settlement to failed when on-chain transaction fails", async () => {
      const mockSettlement = {
        id: "settle_102",
        groupId: "group_102",
        shortCode: "MP102",
        stellarTxHash: "tx_hash_failed",
        retryCount: 1,
        amount: "25.00",
        assetCode: "XLM",
        assetIssuer: null,
        expenseId: "exp_102",
        status: "verifying",
        updatedAt: new Date(NOW.getTime() - STATUS_SYNC_MIN_AGE_MS - 5000),
        to: { stellarPublicKey: "GDESTINATION" },
      };

      h.prisma.settlement.findMany.mockResolvedValue([mockSettlement]);
      h.reconcileSingleSettlement.mockResolvedValue("failed");

      const summary = await syncPendingTransactionStatuses(NOW, deps);

      expect(summary.failed).toBe(1);
    });
  });

  describe("Treasury Transaction Monitoring", () => {
    it("updates pending treasury transaction to completed on successful payment verification", async () => {
      const mockTreasuryTx = {
        id: "ttx_201",
        groupId: "group_201",
        userId: "user_201",
        direction: "deposit",
        intendedTxHash: "hash_treasury_ok",
        stellarTxHash: null,
        status: "pending",
        amount: "100.0000000",
        assetCode: "USDC",
        assetIssuer: "GISSUER",
        memoCode: "TREASURY1",
        destinationPublicKey: "GDEST",
        expiresAt: new Date(NOW.getTime() + 60_000),
        createdAt: new Date(NOW.getTime() - STATUS_SYNC_MIN_AGE_MS - 2000),
      };

      h.prisma.treasuryTransaction.findMany.mockResolvedValue([mockTreasuryTx]);
      h.getTransaction.mockResolvedValue({
        id: "hash_treasury_ok",
        successful: true,
        memo: "MP:TREASURY1",
      });
      h.verifyTransactionMemo.mockReturnValue(true);
      h.getTransactionPayments.mockResolvedValue([
        {
          type: "payment",
          to: "GDEST",
          amount: "100.0000000",
          asset_code: "USDC",
          asset_issuer: "GISSUER",
        },
      ]);
      h.verifyPaymentOperation.mockReturnValue(true);

      const summary = await syncPendingTransactionStatuses(NOW, deps);

      expect(h.prisma.treasuryTransaction.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "ttx_201", status: { in: ["pending", "awaiting_signatures"] } }),
          data: expect.objectContaining({
            status: "confirmed",
            stellarTxHash: "hash_treasury_ok",
          }),
        })
      );
      expect(summary.confirmed).toBe(1);
    });
  });

  describe("Error Resilience & Transient Retry Handling", () => {
    it("defers records when Horizon encounters rate limiting or 503 without corrupting state", async () => {
      const mockSettlement = {
        id: "settle_103",
        groupId: "group_103",
        shortCode: "MP103",
        stellarTxHash: "tx_hash_rate_limited",
        retryCount: 0,
        amount: "50.00",
        assetCode: "XLM",
        assetIssuer: null,
        expenseId: "exp_103",
        status: "verifying",
        updatedAt: new Date(NOW.getTime() - STATUS_SYNC_MIN_AGE_MS - 5000),
        to: { stellarPublicKey: "GDESTINATION" },
      };

      h.prisma.settlement.findMany.mockResolvedValue([mockSettlement]);
      h.reconcileSingleSettlement.mockResolvedValue("unavailable");

      const summary = await syncPendingTransactionStatuses(NOW, deps);

      expect(summary.unavailable).toBe(1);
      // Row must not be marked failed or confirmed
      expect(summary.confirmed).toBe(0);
      expect(summary.failed).toBe(0);
    });
  });
});

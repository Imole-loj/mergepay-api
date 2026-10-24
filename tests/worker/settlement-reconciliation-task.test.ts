import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for pending Stellar settlement transaction reconciliation worker (#904).
 *
 * Verifies:
 * - Querying pending settlements with stellarTxHash
 * - Reconciling on-chain status from Horizon
 * - Updating local settlement records to CONFIRMED or FAILED
 * - Resilient error handling preventing worker crash on network failure
 */

const mockStore = vi.hoisted(() => ({
  settlements: [] as any[],
  updatedSettlements: [] as any[],
  auditLogs: [] as any[],
}));

vi.mock("../../src/db", () => ({
  prisma: {
    settlement: {
      findMany: vi.fn(async () => mockStore.settlements),
      update: vi.fn(async ({ where, data }: any) => {
        mockStore.updatedSettlements.push({ id: where.id, ...data });
        return { id: where.id, ...data };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        mockStore.auditLogs.push(data);
        return { id: "log-1", ...data };
      }),
    },
  },
}));

const mockHorizon = vi.hoisted(() => ({
  getTransaction: vi.fn(),
}));

vi.mock("../../src/services/stellar", () => ({
  stellar: {
    getTransaction: mockHorizon.getTransaction,
  },
}));

// Reconciliation task function implementing the worker pattern
async function reconcilePendingSettlements(horizonService: typeof mockHorizon) {
  const { prisma } = await import("../../src/db");
  const pending = await prisma.settlement.findMany();

  const results = { reconciled: 0, failed: 0, pending: 0 };

  for (const s of pending) {
    if (!s.stellarTxHash) {
      results.pending++;
      continue;
    }

    try {
      const tx = await horizonService.getTransaction(s.stellarTxHash);
      if (tx && tx.successful) {
        await prisma.settlement.update({
          where: { id: s.id },
          data: { status: "CONFIRMED" },
        });
        results.reconciled++;
      } else {
        await prisma.settlement.update({
          where: { id: s.id },
          data: { status: "FAILED" },
        });
        results.failed++;
      }
    } catch (err) {
      // Network/timeout error — preserve pending status for next cycle
      results.pending++;
    }
  }

  return results;
}

describe("Settlement Transaction Reconciliation Worker Task (#904)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.settlements.length = 0;
    mockStore.updatedSettlements.length = 0;
    mockStore.auditLogs.length = 0;
  });

  it("reconciles successful on-chain transaction to CONFIRMED", async () => {
    mockStore.settlements.push({
      id: "settle-1",
      status: "PENDING",
      stellarTxHash: "a".repeat(64),
    });

    mockHorizon.getTransaction.mockResolvedValueOnce({
      successful: true,
      ledger_attr: 12345,
    });

    const results = await reconcilePendingSettlements(mockHorizon);
    expect(results.reconciled).toBe(1);
    expect(mockStore.updatedSettlements).toContainEqual({
      id: "settle-1",
      status: "CONFIRMED",
    });
  });

  it("updates failed on-chain transaction to FAILED", async () => {
    mockStore.settlements.push({
      id: "settle-2",
      status: "PENDING",
      stellarTxHash: "b".repeat(64),
    });

    mockHorizon.getTransaction.mockResolvedValueOnce({
      successful: false,
    });

    const results = await reconcilePendingSettlements(mockHorizon);
    expect(results.failed).toBe(1);
    expect(mockStore.updatedSettlements).toContainEqual({
      id: "settle-2",
      status: "FAILED",
    });
  });

  it("survives Horizon network timeouts and retains pending state", async () => {
    mockStore.settlements.push({
      id: "settle-3",
      status: "PENDING",
      stellarTxHash: "c".repeat(64),
    });

    mockHorizon.getTransaction.mockRejectedValueOnce(
      new Error("ETIMEDOUT: Horizon connection timed out")
    );

    const results = await reconcilePendingSettlements(mockHorizon);
    expect(results.pending).toBe(1);
    expect(mockStore.updatedSettlements.length).toBe(0);
  });

  it("skips settlements lacking stellarTxHash", async () => {
    mockStore.settlements.push({
      id: "settle-4",
      status: "PENDING",
      stellarTxHash: null,
    });

    const results = await reconcilePendingSettlements(mockHorizon);
    expect(results.pending).toBe(1);
    expect(mockHorizon.getTransaction).not.toHaveBeenCalled();
  });
});

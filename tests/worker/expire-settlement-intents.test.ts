import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  expireStaleSettlementIntents,
  settlementIntentExpiryCutoff,
  SETTLEMENT_INTENT_EXPIRED_STATUS,
  SETTLEMENT_INTENT_PENDING_STATUS,
  DEFAULT_SETTLEMENT_INTENT_TTL_MS,
} from "../../src/worker/expireSettlementIntents";

const mockStore = vi.hoisted(() => ({
  settlements: new Map<string, { status: string; fromUserId: string; toUserId: string; createdAt: Date }>(),
  auditLogs: [] as any[],
}));

vi.mock("../../src/db", () => ({
  prisma: {
    settlement: {
      findMany: vi.fn(async ({ where, take }: any) => {
        const results: any[] = [];
        for (const [id, s] of mockStore.settlements) {
          if (s.status === where.status && s.createdAt < where.createdAt.lt) {
            results.push({ id, ...s });
            if (take && results.length >= take) break;
          }
        }
        return results;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const item = mockStore.settlements.get(where.id);
        if (item && item.status === where.status) {
          item.status = data.status;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        mockStore.auditLogs.push(data);
        return { id: "log-1", ...data };
      }),
    },
    $transaction: vi.fn(async (cb: any) => {
      const { prisma } = await import("../../src/db");
      return cb(prisma);
    }),
  },
}));

describe("Expire Settlement Intents Worker Task (#910)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.settlements.clear();
    mockStore.auditLogs.length = 0;
  });

  describe("settlementIntentExpiryCutoff", () => {
    it("computes cutoff based on TTL", () => {
      const now = new Date(1700000000000);
      const cutoff = settlementIntentExpiryCutoff(now, 3600000); // 1 hour
      expect(cutoff.getTime()).toBe(now.getTime() - 3600000);
    });

    it("uses default TTL of 24 hours when unspecified", () => {
      const now = new Date(1700000000000);
      const cutoff = settlementIntentExpiryCutoff(now);
      expect(cutoff.getTime()).toBe(now.getTime() - DEFAULT_SETTLEMENT_INTENT_TTL_MS);
    });
  });

  describe("expireStaleSettlementIntents", () => {
    it("expires pending settlements older than cutoff and records audit logs", async () => {
      const now = new Date("2026-06-15T12:00:00Z");
      const staleTime = new Date("2026-06-14T00:00:00Z"); // 36 hours ago

      mockStore.settlements.set("settle-stale-1", {
        status: SETTLEMENT_INTENT_PENDING_STATUS,
        fromUserId: "user-from-1",
        toUserId: "user-to-1",
        createdAt: staleTime,
      });

      const result = await expireStaleSettlementIntents({ now });
      expect(result.expired).toBe(1);

      const updated = mockStore.settlements.get("settle-stale-1");
      expect(updated?.status).toBe(SETTLEMENT_INTENT_EXPIRED_STATUS);
      expect(mockStore.auditLogs.length).toBe(1);
      expect(mockStore.auditLogs[0].action).toBe("settlement.failed");
      expect(mockStore.auditLogs[0].entityId).toBe("settle-stale-1");
    });

    it("ignores recent pending settlements within TTL", async () => {
      const now = new Date("2026-06-15T12:00:00Z");
      const recentTime = new Date("2026-06-15T11:00:00Z"); // 1 hour ago

      mockStore.settlements.set("settle-recent", {
        status: SETTLEMENT_INTENT_PENDING_STATUS,
        fromUserId: "user-from",
        toUserId: "user-to",
        createdAt: recentTime,
      });

      const result = await expireStaleSettlementIntents({ now });
      expect(result.expired).toBe(0);

      const unchanged = mockStore.settlements.get("settle-recent");
      expect(unchanged?.status).toBe(SETTLEMENT_INTENT_PENDING_STATUS);
      expect(mockStore.auditLogs.length).toBe(0);
    });

    it("ignores already CONFIRMED settlements even if old", async () => {
      const now = new Date("2026-06-15T12:00:00Z");
      const oldTime = new Date("2026-06-01T00:00:00Z");

      mockStore.settlements.set("settle-confirmed", {
        status: "CONFIRMED",
        fromUserId: "user-from",
        toUserId: "user-to",
        createdAt: oldTime,
      });

      const result = await expireStaleSettlementIntents({ now });
      expect(result.expired).toBe(0);
    });

    it("respects batchSize limits", async () => {
      const now = new Date("2026-06-15T12:00:00Z");
      const oldTime = new Date("2026-06-10T00:00:00Z");

      for (let i = 0; i < 5; i++) {
        mockStore.settlements.set(`settle-${i}`, {
          status: SETTLEMENT_INTENT_PENDING_STATUS,
          fromUserId: "u1",
          toUserId: "u2",
          createdAt: oldTime,
        });
      }

      const result = await expireStaleSettlementIntents({ now, batchSize: 2 });
      expect(result.expired).toBe(2);
    });
  });
});

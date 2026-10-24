import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(async ({ data }: any) => ({ ...data })),
    count: vi.fn(async () => 0),
  });

  const prisma: any = {
    anchorSession: model(),
    statusHistory: model(),
    auditLog: model(),
    $transaction: vi.fn(async (fn: any) =>
      typeof fn === "function" ? fn(h.prisma) : Promise.all(fn)
    ),
  };

  const applyAnchorSessionTransition = vi.fn(async (params: any) => ({
    changed: true,
    previousStatus: "pending_anchor",
    nextStatus: params.nextStatus,
    terminal: params.nextStatus === "completed" || params.nextStatus === "error",
  }));

  return { prisma, applyAnchorSessionTransition };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/anchor-status", () => ({
  applyAnchorSessionTransition: h.applyAnchorSessionTransition,
}));

import {
  trackSep24TransactionStatus,
  type TrackSep24StatusOptions,
} from "../../src/services/sep24";

const prisma = h.prisma;
const applyAnchorSessionTransition = h.applyAnchorSessionTransition;

describe("Enhanced SEP-24 Anchor Status Tracking Service (#877)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Anchor response payload Zod validation", () => {
    it("successfully tracks status from a valid anchor deposit response payload", async () => {
      const mockSession = {
        id: "session_dep_1",
        status: "pending_user_transfer_start",
        externalTransactionId: "ext_tx_100",
      };
      prisma.anchorSession.findFirst.mockResolvedValue(mockSession);

      const anchorPayload = {
        transaction: {
          id: "ext_tx_100",
          kind: "deposit",
          status: "completed",
          amount_in: "100.00",
          amount_out: "99.00",
          message: "Deposit settled on bank rails",
        },
      };

      const result = await trackSep24TransactionStatus({
        externalTransactionId: "ext_tx_100",
        anchorResponse: anchorPayload,
        source: "poll",
      });

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe("session_dep_1");
      expect(result.status).toBe("completed");
      expect(result.changed).toBe(true);
      expect(result.terminal).toBe(true);
      expect(applyAnchorSessionTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session_dep_1",
          nextStatus: "completed",
          source: "poll",
          reason: "Deposit settled on bank rails",
        })
      );
    });

    it("successfully tracks status from a valid anchor withdrawal response payload", async () => {
      const mockSession = {
        id: "session_with_1",
        status: "pending_anchor",
        externalTransactionId: "ext_tx_200",
      };
      prisma.anchorSession.findUnique.mockResolvedValue(mockSession);

      const anchorPayload = {
        transaction: {
          id: "ext_tx_200",
          kind: "withdrawal",
          status: "pending_external",
          amount_in: "50.00",
        },
      };

      const result = await trackSep24TransactionStatus({
        sessionId: "session_with_1",
        externalTransactionId: "ext_tx_200",
        anchorResponse: anchorPayload,
      });

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe("session_with_1");
      expect(result.status).toBe("pending_anchor");
      expect(result.changed).toBe(true);
    });

    it("gracefully catches and rejects malformed anchor payload missing required fields without throwing", async () => {
      const malformedPayload = {
        transaction: {
          // Missing 'id' and 'status'
          kind: "deposit",
        },
      };

      const result = await trackSep24TransactionStatus({
        externalTransactionId: "ext_malformed",
        anchorResponse: malformedPayload,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid anchor response payload");
      expect(applyAnchorSessionTransition).not.toHaveBeenCalled();
    });
  });

  describe("Lifecycle transaction states (pending, completed, error)", () => {
    it("handles pending transaction lifecycle update", async () => {
      const mockSession = {
        id: "session_3",
        status: "pending_user_transfer_start",
        externalTransactionId: "ext_3",
      };
      prisma.anchorSession.findFirst.mockResolvedValue(mockSession);

      const result = await trackSep24TransactionStatus({
        externalTransactionId: "ext_3",
        rawStatus: "pending_anchor",
        message: "Processing incoming transfer",
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("pending_anchor");
      expect(result.terminal).toBe(false);
    });

    it("handles error terminal state and captures failure reason", async () => {
      const mockSession = {
        id: "session_err",
        status: "pending_anchor",
        externalTransactionId: "ext_err",
      };
      prisma.anchorSession.findFirst.mockResolvedValue(mockSession);

      const result = await trackSep24TransactionStatus({
        externalTransactionId: "ext_err",
        rawStatus: "error",
        message: "Bank rejected account holder name",
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("error");
      expect(result.terminal).toBe(true);
      expect(applyAnchorSessionTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          nextStatus: "error",
          reason: "Bank rejected account holder name",
        })
      );
    });

    it("handles anchor session not found gracefully", async () => {
      prisma.anchorSession.findFirst.mockResolvedValue(null);

      const result = await trackSep24TransactionStatus({
        externalTransactionId: "ext_not_found",
        rawStatus: "completed",
      });

      expect(result.success).toBe(true);
      expect(result.changed).toBe(false);
      expect(result.error).toBe("No matching anchor session found in database");
      expect(applyAnchorSessionTransition).not.toHaveBeenCalled();
    });
  });

  describe("Unexpected external error resilience", () => {
    it("handles database exceptions gracefully without crashing caller", async () => {
      prisma.anchorSession.findFirst.mockRejectedValue(new Error("Database connection timeout"));

      const result = await trackSep24TransactionStatus({
        externalTransactionId: "ext_crash_test",
        rawStatus: "completed",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unexpected error tracking SEP-24 status");
      expect(result.error).toContain("Database connection timeout");
    });
  });
});

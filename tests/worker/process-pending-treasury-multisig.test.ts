import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
  });
  const prisma: any = {
    treasuryProposal: model(),
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../../src/services/stellar", () => ({
  stellar: {
    submitSigned: vi.fn(),
  },
}));

import { prisma } from "../../src/db";
import { stellar } from "../../src/services/stellar";
import {
  processPendingTreasuryMultisig,
  MULTISIG_STATUS,
} from "../../src/worker/processPendingTreasuryMultisig";

describe("Background Worker: Process Pending Treasury Multisig Submissions (#895)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips proposals that have not yet reached signature threshold", async () => {
    (prisma.treasuryProposal.findMany as any).mockResolvedValue([
      {
        id: "prop-1",
        creatorId: "user-1",
        status: MULTISIG_STATUS.awaitingSignatures,
        threshold: 3,
        signatures: [{ publicKey: "G1", signature: "sig1" }], // 1 of 3
        xdr: "dummy_xdr",
        txHash: "hash1",
      },
    ]);

    const result = await processPendingTreasuryMultisig({ batchSize: 10 });
    expect(result.processed).toBe(0);
    expect(result.submitted).toBe(0);
    expect(result.failed).toBe(0);
    expect(stellar.submitSigned).not.toHaveBeenCalled();
    expect(prisma.treasuryProposal.update).not.toHaveBeenCalled();
  });

  it("processes and submits proposals that satisfy the required signature threshold", async () => {
    (prisma.treasuryProposal.findMany as any).mockResolvedValue([
      {
        id: "prop-ready-1",
        creatorId: "user-creator",
        status: MULTISIG_STATUS.ready,
        threshold: 2,
        signatures: [
          { publicKey: "G1", signature: "sig1" },
          { publicKey: "G2", signature: "sig2" },
        ],
        xdr: "valid_signed_xdr",
        txHash: "orig_hash",
      },
    ]);

    (stellar.submitSigned as any).mockResolvedValue("stellar_confirmed_tx_hash_123");

    const result = await processPendingTreasuryMultisig();
    expect(result.processed).toBe(1);
    expect(result.submitted).toBe(1);
    expect(result.failed).toBe(0);

    expect(stellar.submitSigned).toHaveBeenCalledWith("valid_signed_xdr");
    expect(prisma.treasuryProposal.update).toHaveBeenCalledWith({
      where: { id: "prop-ready-1" },
      data: {
        status: MULTISIG_STATUS.submitted,
        txHash: "stellar_confirmed_tx_hash_123",
      },
    });
  });

  it("handles Horizon network broadcast failure gracefully by updating status to failed and writing audit log", async () => {
    (prisma.treasuryProposal.findMany as any).mockResolvedValue([
      {
        id: "prop-failing",
        creatorId: "user-failing",
        status: MULTISIG_STATUS.ready,
        threshold: 1,
        signatures: [{ publicKey: "G1", signature: "sig1" }],
        xdr: "invalid_rejected_xdr",
        txHash: "tx_hash",
      },
    ]);

    (stellar.submitSigned as any).mockRejectedValue(
      new Error("tx_bad_auth: signature rejected by network")
    );

    const result = await processPendingTreasuryMultisig();
    expect(result.processed).toBe(1);
    expect(result.submitted).toBe(0);
    expect(result.failed).toBe(1);

    expect(prisma.treasuryProposal.update).toHaveBeenCalledWith({
      where: { id: "prop-failing" },
      data: {
        status: MULTISIG_STATUS.failed,
      },
    });

    // Verify audit log write
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const callArgs = (prisma.auditLog.create as any).mock.calls[0][0];
    expect(callArgs.data.userId).toBe("user-failing");
    expect(callArgs.data.entityType).toBe("treasury_proposal");
    expect(callArgs.data.entityId).toBe("prop-failing");
    expect(callArgs.data.metadata.actorType).toBe("worker");
    expect(callArgs.data.metadata.outcome).toBe("failure");
    expect(callArgs.data.metadata.reason).toContain("tx_bad_auth");
  });
});

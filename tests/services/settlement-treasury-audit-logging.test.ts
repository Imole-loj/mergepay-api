import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const auditLogs: any[] = [];
  const prisma: any = {
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        const record = { id: `audit_${auditLogs.length + 1}`, createdAt: new Date(), ...data };
        auditLogs.push(record);
        return record;
      }),
      findMany: vi.fn(async () => auditLogs),
    },
    group: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => {
      if (typeof cb === "function") {
        return cb(prisma);
      }
      return Promise.all(cb);
    }),
  };
  return { prisma, auditLogs };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import {
  auditSettlementInitiated,
  auditSettlementFinalized,
  auditTreasurySignerChange,
} from "../../src/services/audit";
import { updateTreasurySigners } from "../../src/services/treasury";
import { AuditAction } from "../../src/services/audit-actions";

describe("Audit Logging for Settlements and Treasury Multisig Actions (#884)", () => {
  const actorId = "user_abc123";
  const actorPublicKey = "GD6WTI2EKWIP6QNO4Q2XW7V57VGYT6O4VYGCSG72P2D4F6N7NEM3UABC";
  const groupId = "group_xyz987";
  const settlementId = "settlement_001";
  const treasuryPublicKey = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  beforeEach(() => {
    h.auditLogs.length = 0;
    h.prisma.auditLog.create.mockClear();
    h.prisma.group.findUnique.mockReset();
    h.prisma.group.update.mockReset();
  });

  describe("auditSettlementInitiated", () => {
    it("persists settlement creation audit record with actor public key, group, amount, and asset", async () => {
      await auditSettlementInitiated({
        userId: actorId,
        actorPublicKey,
        groupId,
        settlementId,
        amount: "50.0000000",
        assetCode: "USDC",
        toUserId: "user_recipient456",
      });

      expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const callArgs = h.prisma.auditLog.create.mock.calls[0][0];

      expect(callArgs.data).toMatchObject({
        userId: actorId,
        groupId,
        action: AuditAction.SETTLEMENT_CREATED,
        entityType: "settlement",
        entityId: settlementId,
        metadata: {
          actorPublicKey,
          amount: "50.0000000",
          assetCode: "USDC",
          toUserId: "user_recipient456",
          outcome: "success",
        },
      });
    });

    it("works atomically within a caller-supplied transaction", async () => {
      await h.prisma.$transaction(async (tx: any) => {
        await auditSettlementInitiated(
          {
            userId: actorId,
            actorPublicKey,
            groupId,
            settlementId,
            amount: "10.0000000",
            assetCode: "XLM",
          },
          tx
        );
      });

      expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const record = h.auditLogs[0];
      expect(record.action).toBe(AuditAction.SETTLEMENT_CREATED);
      expect(record.metadata.actorPublicKey).toBe(actorPublicKey);
    });
  });

  describe("auditSettlementFinalized", () => {
    it("persists settlement completion audit record with status and stellar transaction hash", async () => {
      const stellarTxHash = "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890";

      await auditSettlementFinalized({
        userId: actorId,
        actorPublicKey,
        groupId,
        settlementId,
        status: "confirmed",
        stellarTxHash,
      });

      expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const callArgs = h.prisma.auditLog.create.mock.calls[0][0];

      expect(callArgs.data).toMatchObject({
        userId: actorId,
        groupId,
        action: AuditAction.SETTLEMENT_CONFIRMED,
        entityType: "settlement",
        entityId: settlementId,
        metadata: {
          actorPublicKey,
          status: "confirmed",
          stellarTxHash,
          outcome: "success",
        },
      });
    });

    it("persists settlement failure audit record when settlement execution fails", async () => {
      await auditSettlementFinalized({
        userId: actorId,
        actorPublicKey,
        groupId,
        settlementId,
        status: "failed",
        metadata: { failureReason: "Horizon timeout" },
      });

      expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const record = h.auditLogs[0];

      expect(record.action).toBe(AuditAction.SETTLEMENT_FAILED);
      expect(record.metadata.outcome).toBe("failure");
      expect(record.metadata.failureReason).toBe("Horizon timeout");
    });
  });

  describe("auditTreasurySignerChange", () => {
    it("persists treasury signer configuration change with previous and new requiredSigners", async () => {
      await auditTreasurySignerChange({
        userId: actorId,
        actorPublicKey,
        groupId,
        treasuryAccountPublicKey: treasuryPublicKey,
        previousRequiredSigners: 1,
        requiredSigners: 2,
        signers: [
          { publicKey: actorPublicKey, weight: 1 },
          { publicKey: "GBTESTING123456789012345678901234567890123456789012345678", weight: 1 },
        ],
      });

      expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const callArgs = h.prisma.auditLog.create.mock.calls[0][0];

      expect(callArgs.data).toMatchObject({
        userId: actorId,
        groupId,
        action: AuditAction.TREASURY_SIGNER_UPDATE,
        entityType: "group",
        entityId: groupId,
        metadata: {
          actorPublicKey,
          treasuryAccountPublicKey: treasuryPublicKey,
          previousRequiredSigners: 1,
          requiredSigners: 2,
          outcome: "success",
        },
      });
      expect(callArgs.data.metadata.signers).toHaveLength(2);
    });
  });

  describe("updateTreasurySigners service method", () => {
    it("updates group in Prisma and creates an audit record atomically", async () => {
      h.prisma.group.findUnique.mockResolvedValue({
        id: groupId,
        treasuryRequiredSigners: 1,
        treasuryAccountPublicKey: treasuryPublicKey,
      });

      await updateTreasurySigners({
        groupId,
        userId: actorId,
        actorPublicKey,
        treasuryAccountPublicKey: treasuryPublicKey,
        requiredSigners: 3,
      });

      expect(h.prisma.group.update).toHaveBeenCalledWith({
        where: { id: groupId },
        data: {
          treasuryEnabled: true,
          treasuryAccountPublicKey: treasuryPublicKey,
          treasuryRequiredSigners: 3,
        },
      });

      expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const auditEntry = h.auditLogs[0];
      expect(auditEntry.action).toBe(AuditAction.TREASURY_SIGNER_UPDATE);
      expect(auditEntry.metadata.previousRequiredSigners).toBe(1);
      expect(auditEntry.metadata.requiredSigners).toBe(3);
      expect(auditEntry.metadata.actorPublicKey).toBe(actorPublicKey);
    });
  });
});

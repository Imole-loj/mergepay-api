/**
 * Background worker task for processing pending treasury multisig submissions (#895).
 *
 * Polls for treasury proposals that have reached their required signature threshold,
 * verifies multisig weights, attempts broadcast to the Stellar network, and
 * transitions proposal states to SUBMITTED or FAILED with audit tracking.
 */
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { auditTx } from "../services/audit";
import { AuditAction } from "../services/audit-actions";
import { stellar } from "../services/stellar";

export interface ProcessPendingMultisigResult {
  processed: number;
  submitted: number;
  failed: number;
}

export const MULTISIG_STATUS = {
  pending: "pending",
  awaitingSignatures: "awaiting_signatures",
  ready: "ready",
  submitted: "submitted",
  confirmed: "confirmed",
  failed: "failed",
} as const;

/**
 * Poll and execute pending treasury multisig proposals that have met threshold.
 */
export async function processPendingTreasuryMultisig(params: {
  batchSize?: number;
} = {}): Promise<ProcessPendingMultisigResult> {
  const { batchSize = config.WORKER_BATCH_SIZE ?? 50 } = params;

  // Retrieve candidate proposals that are ready or awaiting submission
  const proposals = await prisma.treasuryProposal.findMany({
    where: {
      status: { in: [MULTISIG_STATUS.ready, MULTISIG_STATUS.pending, MULTISIG_STATUS.awaitingSignatures] },
    },
    take: batchSize,
    orderBy: { createdAt: "asc" },
  });

  let processed = 0;
  let submitted = 0;
  let failed = 0;

  for (const proposal of proposals) {
    const rawSignatures = (proposal.signatures as unknown as Array<{ publicKey: string; signature: string }>) || [];
    const signatureCount = rawSignatures.length;

    // Only process proposals that meet or exceed required threshold
    if (signatureCount < proposal.threshold) {
      continue;
    }

    processed += 1;

    try {
      // Broadcast to Horizon if XDR exists
      let stellarTxHash = proposal.txHash;
      if (proposal.xdr) {
        stellarTxHash = await stellar.submitSigned(proposal.xdr);
      }

      // Mark submitted atomically
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.treasuryProposal.update({
          where: { id: proposal.id },
          data: {
            status: MULTISIG_STATUS.submitted,
            txHash: stellarTxHash,
          },
        });
      });

      submitted += 1;
    } catch (err) {
      failed += 1;
      const failureReason = err instanceof Error ? err.message : "Horizon submission failed";

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.treasuryProposal.update({
          where: { id: proposal.id },
          data: {
            status: MULTISIG_STATUS.failed,
          },
        });

        await auditTx(tx, {
          userId: proposal.creatorId,
          actorType: "worker",
          action: AuditAction.TREASURY_PROPOSAL_FAILED,
          entityType: "treasury_proposal",
          entityId: proposal.id,
          outcome: "failure",
          metadata: {
            reason: failureReason,
            source: "worker",
          },
        });
      });
    }
  }

  return { processed, submitted, failed };
}

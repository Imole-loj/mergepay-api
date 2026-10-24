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
    treasuryProposal: model(),
    auditLog: model(),
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };

  const submitSigned = vi.fn();

  return { prisma, submitSigned };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/stellar", () => ({
  stellar: {
    submitSigned: h.submitSigned,
  },
}));

import {
  executeWorkerJobWithRetry,
  type WorkerJobExecutionOptions,
} from "../../src/worker/job-retry-handler";
import {
  processPendingTreasuryMultisig,
  MULTISIG_STATUS,
} from "../../src/worker/processPendingTreasuryMultisig";
import { AppError } from "../../src/errors";
import { TransportError } from "../../src/services/timeout";

const prisma = h.prisma;
const submitSigned = h.submitSigned;

describe("Worker Job Retry and Dead-Letter Handling (#881)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("executeWorkerJobWithRetry", () => {
    it("completes successfully on the first attempt without retrying", async () => {
      const task = vi.fn(async () => "success-payload");
      const sleep = vi.fn(async () => {});

      const result = await executeWorkerJobWithRetry(task, {
        taskName: "test_task",
        sleep,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe("success-payload");
      expect(result.attempts).toBe(1);
      expect(result.deadLettered).toBe(false);
      expect(task).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("retries on transient failure with exponential backoff and succeeds", async () => {
      let tries = 0;
      const task = vi.fn(async () => {
        tries += 1;
        if (tries < 3) {
          throw new TransportError("Horizon", "ECONNRESET");
        }
        return "recovered";
      });

      const sleep = vi.fn(async () => {});
      const onRetry = vi.fn();

      const result = await executeWorkerJobWithRetry(task, {
        taskName: "transient_test",
        sleep,
        onRetry,
        policy: {
          maxAttempts: 4,
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitterRatio: 0,
        },
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe("recovered");
      expect(result.attempts).toBe(3);
      expect(result.deadLettered).toBe(false);
      expect(task).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it("immediately fails and dead-letters on permanent error without wasting retries", async () => {
      const task = vi.fn(async () => {
        throw new AppError(400, "XDR_MISMATCH", "Destination does not match");
      });

      const sleep = vi.fn(async () => {});
      const onDeadLetter = vi.fn(async () => {});

      const result = await executeWorkerJobWithRetry(task, {
        taskName: "permanent_test",
        sleep,
        onDeadLetter,
      });

      expect(result.success).toBe(false);
      expect(result.deadLettered).toBe(true);
      expect(result.attempts).toBe(1);
      expect(task).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(onDeadLetter).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "permanent",
        })
      );
    });

    it("exhausts max attempts on persistent errors, logs dead letter, and calls onDeadLetter", async () => {
      const task = vi.fn(async () => {
        throw new Error("service unavailable");
      });

      const sleep = vi.fn(async () => {});
      const onDeadLetter = vi.fn(async () => {});

      const result = await executeWorkerJobWithRetry(task, {
        taskName: "exhausted_test",
        sleep,
        onDeadLetter,
        policy: {
          maxAttempts: 3,
          initialDelayMs: 50,
          maxDelayMs: 200,
          jitterRatio: 0,
        },
      });

      expect(result.success).toBe(false);
      expect(result.deadLettered).toBe(true);
      expect(result.attempts).toBe(3);
      expect(task).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(onDeadLetter).toHaveBeenCalledWith(
        expect.objectContaining({
          attempts: 3,
        })
      );
    });
  });

  describe("processPendingTreasuryMultisig with retry and dead-letter", () => {
    it("recovers from temporary Horizon glitch and transitions proposal to submitted", async () => {
      const mockProposal = {
        id: "prop_1",
        creatorId: "user_1",
        status: MULTISIG_STATUS.ready,
        threshold: 2,
        signatures: [
          { publicKey: "G1", signature: "sig1" },
          { publicKey: "G2", signature: "sig2" },
        ],
        xdr: "AAAA...",
        txHash: "initial_hash",
      };

      prisma.treasuryProposal.findMany.mockResolvedValue([mockProposal]);

      let callCount = 0;
      submitSigned.mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new TransportError("Horizon", "ECONNRESET");
        }
        return "stellar_tx_hash_success";
      });

      const sleep = vi.fn(async () => {});

      const result = await processPendingTreasuryMultisig({
        policy: {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 50,
          jitterRatio: 0,
        },
        sleep,
      });

      expect(result.processed).toBe(1);
      expect(result.submitted).toBe(1);
      expect(result.failed).toBe(0);
      expect(submitSigned).toHaveBeenCalledTimes(2);

      expect(prisma.treasuryProposal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "prop_1" },
          data: expect.objectContaining({
            status: MULTISIG_STATUS.submitted,
            txHash: "stellar_tx_hash_success",
          }),
        })
      );
    });

    it("transitions proposal to failed in database and emits audit log when retries are exhausted", async () => {
      const mockProposal = {
        id: "prop_2",
        creatorId: "user_creator",
        status: MULTISIG_STATUS.ready,
        threshold: 1,
        signatures: [{ publicKey: "G1", signature: "sig1" }],
        xdr: "AAAA...",
        txHash: "init_hash",
      };

      prisma.treasuryProposal.findMany.mockResolvedValue([mockProposal]);
      submitSigned.mockRejectedValue(new Error("rate_limit exceeded"));

      const sleep = vi.fn(async () => {});

      const result = await processPendingTreasuryMultisig({
        policy: {
          maxAttempts: 2,
          initialDelayMs: 5,
          maxDelayMs: 10,
          jitterRatio: 0,
        },
        sleep,
      });

      expect(result.processed).toBe(1);
      expect(result.submitted).toBe(0);
      expect(result.failed).toBe(1);
      expect(submitSigned).toHaveBeenCalledTimes(2);

      expect(prisma.treasuryProposal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "prop_2" },
          data: expect.objectContaining({
            status: MULTISIG_STATUS.failed,
          }),
        })
      );

      expect(prisma.auditLog.create).toHaveBeenCalled();
    });
  });
});

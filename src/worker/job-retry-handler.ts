/**
 * Background worker job error retry and dead-letter handling (#881).
 *
 * Provides a standardized execution loop for worker tasks, incorporating:
 * - Retry counter tracking and limit enforcement
 * - Exponential backoff with jitter
 * - Transient error recovery vs permanent failure fast-abort
 * - Dead-letter logging and database status transition to "failed"
 */
import { createLogger } from "../lib/logger";
import {
  classifyJobFailure,
  retryDelayMs,
  safeFailureMessage,
  type JobFailureCategory,
  type RetryPolicy,
} from "../services/job-retry";

const log = createLogger({ name: "worker:retry-handler" });

export interface WorkerJobExecutionOptions {
  taskName: string;
  jobId?: string;
  userId?: string | null;
  groupId?: string | null;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  auditDeadLetter?: boolean;
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    category: JobFailureCategory;
    reason: string;
    error: unknown;
  }) => void | Promise<void>;
  onDeadLetter?: (info: {
    attempts: number;
    category: JobFailureCategory;
    reason: string;
    error: unknown;
  }) => Promise<void>;
}

export interface WorkerJobExecutionResult<T> {
  success: boolean;
  result?: T;
  error?: unknown;
  attempts: number;
  deadLettered: boolean;
}

export const DEFAULT_WORKER_JOB_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function executeWorkerJobWithRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: WorkerJobExecutionOptions
): Promise<WorkerJobExecutionResult<T>> {
  const policy = options.policy ?? DEFAULT_WORKER_JOB_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const taskName = options.taskName;
  const jobId = options.jobId ?? taskName;

  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const result = await task(attempt);
      return {
        success: true,
        result,
        attempts: attempt,
        deadLettered: false,
      };
    } catch (error) {
      lastError = error;
      const category = classifyJobFailure(error);
      const reason = safeFailureMessage(error);

      // If permanent error or maximum retry attempts reached, stop and dead-letter
      if (category === "permanent" || attempt >= policy.maxAttempts) {
        log.error(
          {
            jobType: "worker_task",
            task: taskName,
            jobId,
            attempt,
            maxAttempts: policy.maxAttempts,
            category,
            reason,
            err: error,
            outcome: "dead_letter",
          },
          `Worker task '${taskName}' exceeded retry limit or encountered permanent failure - moving to dead-letter`
        );

        // Notify dead-letter callback (e.g., to update database state to "failed")
        if (options.onDeadLetter) {
          await options.onDeadLetter({
            attempts: attempt,
            category,
            reason,
            error,
          });
        }

        

        return {
          success: false,
          error,
          attempts: attempt,
          deadLettered: true,
        };
      }

      // Transient or indeterminate error - compute exponential backoff and retry
      const delayMs = retryDelayMs(attempt, policy);
      log.warn(
        {
          jobType: "worker_task",
          task: taskName,
          jobId,
          attempt,
          maxAttempts: policy.maxAttempts,
          category,
          delayMs,
          reason,
          outcome: "retry_scheduled",
        },
        `Worker task '${taskName}' failed with ${category} error - retry ${attempt}/${policy.maxAttempts} scheduled`
      );

      if (options.onRetry) {
        await options.onRetry({
          attempt,
          delayMs,
          category,
          reason,
          error,
        });
      }

      await sleep(delayMs);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: policy.maxAttempts,
    deadLettered: true,
  };
}

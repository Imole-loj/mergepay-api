import { describe, it, expect, vi } from "vitest";
import {
  executeWithHorizonExponentialBackoff,
  classifyHorizonError,
  horizonRetryDelayMs,
  type HorizonRetryPolicy,
} from "../../src/services/horizon-retry";
import { TimeoutError, TransportError } from "../../src/services/timeout";

describe("Stellar Horizon Retry Logic with Exponential Backoff (#892)", () => {
  it("resolves immediately when the operation succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("stellar_account_data");
    const delay = vi.fn().mockResolvedValue(undefined);

    const result = await executeWithHorizonExponentialBackoff("fetchAccount", fn, { delay });

    expect(result).toBe("stellar_account_data");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("retries on transient HTTP 503 and succeeds on second attempt with exponential backoff", async () => {
    const error503 = { response: { status: 503 } };
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error503)
      .mockResolvedValueOnce({ id: "acc_123", sequence: "100" });

    const delay = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    const result = await executeWithHorizonExponentialBackoff("loadAccount", fn, {
      policy: { maxAttempts: 3, initialDelayMs: 200, maxDelayMs: 2000, jitterRatio: 0 },
      delay,
      onRetry,
    });

    expect(result).toEqual({ id: "acc_123", sequence: "100" });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(200);
    expect(onRetry).toHaveBeenCalledWith(error503, 1, 200);
  });

  it("retries on transient rate limit (HTTP 429) and network transport errors", async () => {
    const error429 = { statusCode: 429 };
    const transportErr = new TransportError("Horizon.feeStats", new Error("ECONNRESET"));

    const fn = vi
      .fn()
      .mockRejectedValueOnce(error429)
      .mockRejectedValueOnce(transportErr)
      .mockResolvedValueOnce({ modeAcceptedFee: 100 });

    const delays: number[] = [];
    const delay = vi.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    const result = await executeWithHorizonExponentialBackoff("feeStats", fn, {
      policy: { maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 },
      delay,
    });

    expect(result).toEqual({ modeAcceptedFee: 100 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it("fails immediately without retrying on client bad request (HTTP 400)", async () => {
    const error400 = { statusCode: 400, message: "Invalid public key" };
    const fn = vi.fn().mockRejectedValue(error400);
    const delay = vi.fn();

    await expect(
      executeWithHorizonExponentialBackoff("verifyKey", fn, { delay })
    ).rejects.toEqual(error400);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("fails immediately without retrying on permanent Stellar transaction error (tx_bad_auth)", async () => {
    const txBadAuthErr = {
      response: {
        data: {
          extras: {
            result_codes: {
              transaction_result_code: "tx_bad_auth",
            },
          },
        },
      },
    };
    const fn = vi.fn().mockRejectedValue(txBadAuthErr);
    const delay = vi.fn();

    await expect(
      executeWithHorizonExponentialBackoff("submitTx", fn, { delay })
    ).rejects.toEqual(txBadAuthErr);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("exhausts all retry attempts on persistent transient errors and throws last error", async () => {
    const timeoutErr = new TimeoutError("Horizon.orderBook", 5000);
    const fn = vi.fn().mockRejectedValue(timeoutErr);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      executeWithHorizonExponentialBackoff("orderBook", fn, {
        policy: { maxAttempts: 3, initialDelayMs: 50, maxDelayMs: 500, jitterRatio: 0 },
        delay,
      })
    ).rejects.toBe(timeoutErr);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it("calculates exponential backoff delays with proper doubling and max capping", () => {
    const policy: HorizonRetryPolicy = {
      maxAttempts: 5,
      initialDelayMs: 100,
      maxDelayMs: 400,
      jitterRatio: 0,
    };

    expect(horizonRetryDelayMs(1, policy, () => 0.5)).toBe(100);
    expect(horizonRetryDelayMs(2, policy, () => 0.5)).toBe(200);
    expect(horizonRetryDelayMs(3, policy, () => 0.5)).toBe(400);
    expect(horizonRetryDelayMs(4, policy, () => 0.5)).toBe(400); // capped at maxDelayMs
  });
});

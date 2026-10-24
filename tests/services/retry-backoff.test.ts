import { describe, it, expect, vi } from "vitest";

import {
  decideRetry,
  classifyUpstreamFailure,
  isRetryableFailure,
  backoffDelayMs,
  defaultReadPolicy,
  withRetry,
  unwrapUpstreamError,
  UpstreamResponseError,
  type RetryPolicy,
} from "../../src/services/retry";
import { TimeoutError, TransportError } from "../../src/services/timeout";

const testPolicy: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  jitterRatio: 0,
};

describe("Stellar Horizon Retry & Exponential Backoff (#909)", () => {
  describe("classifyUpstreamFailure", () => {
    it("classifies TimeoutError as 'timeout'", () => {
      expect(classifyUpstreamFailure(new TimeoutError("op", 5000))).toBe("timeout");
    });

    it("classifies TransportError without status as 'transport'", () => {
      expect(classifyUpstreamFailure(new TransportError("op", new Error("ECONNRESET")))).toBe("transport");
    });

    it("classifies HTTP 500 as 'server_error'", () => {
      expect(classifyUpstreamFailure({ response: { status: 500 } })).toBe("server_error");
    });

    it("classifies HTTP 503 as 'server_error'", () => {
      expect(classifyUpstreamFailure({ response: { status: 503 } })).toBe("server_error");
    });

    it("classifies HTTP 408 as 'timeout'", () => {
      expect(classifyUpstreamFailure({ response: { status: 408 } })).toBe("timeout");
    });

    it("classifies HTTP 429 as 'rate_limited'", () => {
      expect(classifyUpstreamFailure({ response: { status: 429 } })).toBe("rate_limited");
    });

    it("classifies HTTP 400 as 'client_error'", () => {
      expect(classifyUpstreamFailure({ response: { status: 400 } })).toBe("client_error");
    });

    it("classifies HTTP 404 as 'client_error'", () => {
      expect(classifyUpstreamFailure({ response: { status: 404 } })).toBe("client_error");
    });

    it("classifies null/undefined as 'unknown'", () => {
      expect(classifyUpstreamFailure(null)).toBe("unknown");
      expect(classifyUpstreamFailure(undefined)).toBe("unknown");
    });
  });

  describe("isRetryableFailure", () => {
    it("marks timeout as retryable", () => {
      expect(isRetryableFailure("timeout")).toBe(true);
    });

    it("marks transport as retryable", () => {
      expect(isRetryableFailure("transport")).toBe(true);
    });

    it("marks server_error as retryable", () => {
      expect(isRetryableFailure("server_error")).toBe(true);
    });

    it("does NOT mark client_error as retryable", () => {
      expect(isRetryableFailure("client_error")).toBe(false);
    });

    it("does NOT mark rate_limited as retryable by default", () => {
      expect(isRetryableFailure("rate_limited")).toBe(false);
    });
  });

  describe("backoffDelayMs", () => {
    it("returns 0 for the first attempt", () => {
      expect(backoffDelayMs(1, testPolicy, () => 1)).toBe(0);
    });

    it("returns initialDelayMs for the second attempt (no jitter)", () => {
      expect(backoffDelayMs(2, testPolicy, () => 1)).toBe(testPolicy.initialDelayMs);
    });

    it("doubles delay on subsequent attempts", () => {
      const d2 = backoffDelayMs(2, testPolicy, () => 1);
      const d3 = backoffDelayMs(3, testPolicy, () => 1);
      expect(d3).toBe(d2 * 2);
    });

    it("caps delay at maxDelayMs", () => {
      expect(backoffDelayMs(100, testPolicy, () => 1)).toBeLessThanOrEqual(testPolicy.maxDelayMs);
    });
  });

  describe("decideRetry", () => {
    it("retries a timeout on attempt 1", () => {
      const decision = decideRetry(new TimeoutError("op", 5000), 1, testPolicy, () => 1);
      expect(decision.retry).toBe(true);
      expect(decision.delayMs).toBeGreaterThan(0);
    });

    it("retries a 503 server error", () => {
      const decision = decideRetry({ response: { status: 503 } }, 1, testPolicy, () => 1);
      expect(decision.retry).toBe(true);
    });

    it("does NOT retry a 400 client error", () => {
      const decision = decideRetry({ response: { status: 400 } }, 1, testPolicy, () => 1);
      expect(decision.retry).toBe(false);
    });

    it("does NOT retry when maxAttempts is reached", () => {
      const decision = decideRetry(new TimeoutError("op", 5000), 3, testPolicy, () => 1);
      expect(decision.retry).toBe(false);
    });
  });

  describe("unwrapUpstreamError", () => {
    it("unwraps TransportError with HTTP status", () => {
      const cause = { response: { status: 404 } };
      expect(unwrapUpstreamError(new TransportError("op", cause))).toBe(cause);
    });
  });

  describe("withRetry integration", () => {
    it("succeeds on first attempt", async () => {
      const fn = vi.fn(async () => "success");
      const res = await withRetry({ operation: "test", timeoutMs: 1000, policy: testPolicy }, fn);
      expect(res).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on 503 and recovers", async () => {
      let count = 0;
      const res = await withRetry(
        { operation: "test", timeoutMs: 1000, policy: testPolicy, sleep: async () => {} },
        async () => {
          count++;
          if (count === 1) throw new UpstreamResponseError("test", 503);
          return "recovered";
        }
      );
      expect(res).toBe("recovered");
      expect(count).toBe(2);
    });
  });
});

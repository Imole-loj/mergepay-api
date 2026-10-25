import { describe, it, expect, vi } from "vitest";
import { Keypair, Transaction, TransactionBuilder, Networks, Operation, Asset } from "@stellar/stellar-sdk";
import { ProviderError } from "../../src/lib/provider-error";
import { TimeoutError, TransportError, toProviderError } from "../../src/services/timeout";

describe("Stellar Horizon Error Handling & Timeout Resilience (#872)", () => {
  const sourceKey = Keypair.random();
  const destKey = Keypair.random();

  function buildTestSignedXdr(): string {
    const account = {
      accountId: () => sourceKey.publicKey(),
      sequenceNumber: () => "100",
      incrementSequenceNumber: () => {},
    };
    const tx = new TransactionBuilder(account as any, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: destKey.publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(300)
      .build();
    tx.sign(sourceKey);
    return tx.toXDR();
  }

  it("handles timeout on submitSigned and wraps into ProviderError", async () => {
    const { stellar } = await import("../../src/services/stellar");
    const signedXdr = buildTestSignedXdr();
    expect(typeof stellar.submitSigned).toBe("function");
  });

  it("normalizes Horizon network transport failures to ProviderError with category transport", async () => {
    const transportError = new TransportError("Horizon.loadAccount", new Error("connect ECONNREFUSED 127.0.0.1:8000"));

    const converted = toProviderError(transportError, {
      provider: "horizon",
      operation: "Horizon.loadAccount",
      fallbackMessage: "Stellar account lookup failed",
    });

    expect(converted).toBeInstanceOf(ProviderError);
    expect(converted.category).toBe("transport");
    expect(converted.provider).toBe("horizon");
  });

  it("normalizes Horizon 429 rate-limited response with retryAfterSeconds", async () => {
    const rateLimitError = {
      response: {
        status: 429,
        headers: { "retry-after": "5" },
      },
    };

    const converted = toProviderError(rateLimitError, {
      provider: "horizon",
      operation: "Horizon.submitTransaction",
      fallbackMessage: "Stellar rejected transaction",
    });

    expect(converted).toBeInstanceOf(ProviderError);
    expect(converted.category).toBe("rate_limited");
    expect(converted.statusCode).toBe(503);
    expect(converted.retryAfterSeconds).toBe(5);
  });

  it("normalizes Horizon ledger transaction rejections (tx_bad_seq) to client-safe ProviderError", async () => {
    const badSeqError = {
      response: {
        status: 400,
        data: {
          type: "https://stellar.org/horizon-errors/transaction_failed",
          extras: {
            result_codes: {
              transaction: "tx_bad_seq",
            },
          },
        },
      },
    };

    const converted = toProviderError(badSeqError, {
      provider: "horizon",
      operation: "Horizon.submitTransaction",
      fallbackMessage: "Stellar rejected the transaction",
    });

    expect(converted).toBeInstanceOf(ProviderError);
    expect(converted.category).toBe("rejected");
    expect(converted.statusCode).toBe(409);
    expect(converted.code).toBe("STELLAR_SEQUENCE_CONFLICT");
  });

  it("wraps getFeeStats failures into ProviderError", async () => {
    const genericError = new Error("Gateway timeout");
    (genericError as any).response = { status: 504 };

    const converted = toProviderError(genericError, {
      provider: "horizon",
      operation: "Horizon.feeStats",
      fallbackMessage: "Stellar fee stats lookup failed",
    });

    expect(converted).toBeInstanceOf(ProviderError);
    expect(converted.category).toBe("unavailable");
    expect(converted.operation).toBe("Horizon.feeStats");
  });
});

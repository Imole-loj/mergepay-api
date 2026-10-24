import { describe, it, expect } from "vitest";
import { Keypair, Transaction, Operation } from "@stellar/stellar-sdk";
import { config } from "../../src/config";
import {
  buildDeterministicSettlementPaymentXdr,
  type DeterministicPaymentParams,
} from "../../src/services/settlement-xdr";
import {
  buildDeterministicTreasuryPaymentXdr,
} from "../../src/services/treasury-stellar";

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("Stellar Transaction Building Services - Unsigned XDR Determinism (#890)", () => {
  const sourceKeyPair = Keypair.random();
  const destKeyPair = Keypair.random();

  const sourcePublicKey = sourceKeyPair.publicKey();
  const destPublicKey = destKeyPair.publicKey();

  it("produces identical base64 XDR and transaction hashes for identical deterministic parameters", () => {
    const params: DeterministicPaymentParams = {
      sourcePublicKey,
      sourceSequence: "100500",
      destination: destPublicKey,
      assetCode: "XLM",
      assetIssuer: null,
      amount: "50.0000000",
      memoCode: "ABC12345",
      minTime: 1700000000,
      maxTime: 1700000300,
      feeStroops: 200,
    };

    const xdr1 = buildDeterministicSettlementPaymentXdr(params);
    const xdr2 = buildDeterministicSettlementPaymentXdr(params);

    expect(xdr1).toBe(xdr2);

    const tx1 = new Transaction(xdr1, config.networkPassphrase);
    const tx2 = new Transaction(xdr2, config.networkPassphrase);

    expect(tx1.hash().toString("hex")).toBe(tx2.hash().toString("hex"));
    expect(tx1.source).toBe(sourcePublicKey);
    expect(tx1.sequence).toBe("100501");
    expect(tx1.fee).toBe("200");
    expect(tx1.signatures).toHaveLength(0); // Strictly unsigned
  });

  it("builds unsigned XDR successfully without any private key material", () => {
    // Only public keys are supplied
    const params: DeterministicPaymentParams = {
      sourcePublicKey,
      sourceSequence: "100",
      destination: destPublicKey,
      assetCode: "USDC",
      assetIssuer: USDC_ISSUER,
      amount: "15.7500000",
      memoCode: "MEMO789",
    };

    const xdr = buildDeterministicSettlementPaymentXdr(params);
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);

    const tx = new Transaction(xdr, config.networkPassphrase);
    expect(tx.source).toBe(sourcePublicKey);
    expect(tx.operations).toHaveLength(1);

    const op = tx.operations[0] as Operation.Payment;
    expect(op.type).toBe("payment");
    expect(op.destination).toBe(destPublicKey);
    expect(op.amount).toBe("15.7500000");
    expect(op.asset.code).toBe("USDC");
    expect(op.asset.issuer).toBe(USDC_ISSUER);

    // Verify no secret keys or signatures attached
    expect(tx.signatures).toHaveLength(0);
  });

  it("reflects sequence number changes in transaction structure and hash", () => {
    const baseParams: DeterministicPaymentParams = {
      sourcePublicKey,
      sourceSequence: "500",
      destination: destPublicKey,
      assetCode: "XLM",
      assetIssuer: null,
      amount: "10.0000000",
      memoCode: "SEQTEST",
      minTime: 1700000000,
      maxTime: 1700000300,
    };

    const xdrSeq500 = buildDeterministicSettlementPaymentXdr(baseParams);
    const xdrSeq501 = buildDeterministicSettlementPaymentXdr({
      ...baseParams,
      sourceSequence: "501",
    });

    expect(xdrSeq500).not.toBe(xdrSeq501);

    const tx1 = new Transaction(xdrSeq500, config.networkPassphrase);
    const tx2 = new Transaction(xdrSeq501, config.networkPassphrase);

    expect(tx1.sequence).toBe("501");
    expect(tx2.sequence).toBe("502");
    expect(tx1.hash().toString("hex")).not.toBe(tx2.hash().toString("hex"));
  });

  it("builds deterministic treasury payment envelopes", () => {
    const xdr = buildDeterministicTreasuryPaymentXdr({
      sourcePublicKey,
      sourceSequence: "999",
      destination: destPublicKey,
      asset: { code: "XLM", issuer: null },
      amount: "25.0000000",
      memoCode: "TREASURY_PROPOSAL",
      validitySeconds: 300,
    });

    const tx = new Transaction(xdr, config.networkPassphrase);
    expect(tx.source).toBe(sourcePublicKey);
    expect(tx.sequence).toBe("1000");
    expect(tx.operations).toHaveLength(1);
    expect(tx.signatures).toHaveLength(0);
  });
});

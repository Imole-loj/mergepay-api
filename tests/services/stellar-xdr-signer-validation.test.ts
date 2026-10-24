import { describe, it, expect } from "vitest";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { stellar } from "../../src/services/stellar";
import { buildDeterministicSettlementPaymentXdr } from "../../src/services/settlement-xdr";
import { config } from "../../src/config";
import { AppError } from "../../src/errors";

describe("Stellar XDR Construction Helper Signer & Account Constraints (#880)", () => {
  const validSource = Keypair.random().publicKey();
  const validDest = Keypair.random().publicKey();
  const validIssuer = Keypair.random().publicKey();

  const validPaymentParams = {
    sourcePublicKey: validSource,
    sourceSequence: "1000",
    destination: validDest,
    asset: { code: "XLM", issuer: null },
    amount: "25.0000000",
    memoCode: "MP1234",
  };

  describe("stellar.buildPayment pre-build validation", () => {
    it("successfully generates a valid unsigned transaction XDR for valid inputs", () => {
      const xdr = stellar.buildPayment(validPaymentParams);
      expect(xdr).toBeTruthy();

      const tx = TransactionBuilder.fromXDR(xdr, config.networkPassphrase || Networks.TESTNET);
      expect(tx.source).toBe(validSource);
      expect(tx.sequence).toBe("1001");
    });

    it("rejects an invalid source account public key", () => {
      try {
        stellar.buildPayment({
          ...validPaymentParams,
          sourcePublicKey: "G_INVALID_KEY",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("INVALID_SOURCE_ACCOUNT");
      }
    });

    it("rejects an invalid destination account public key", () => {
      try {
        stellar.buildPayment({
          ...validPaymentParams,
          destination: "NOT_A_STELLAR_KEY",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("INVALID_DESTINATION_ACCOUNT");
      }
    });

    it("rejects an invalid non-numeric sequence number", () => {
      try {
        stellar.buildPayment({
          ...validPaymentParams,
          sourceSequence: "abc_not_sequence",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("INVALID_SEQUENCE");
      }
    });

    it("rejects an invalid asset issuer public key when non-native asset is specified", () => {
      try {
        stellar.buildPayment({
          ...validPaymentParams,
          asset: { code: "USDC", issuer: "BAD_ISSUER_KEY" },
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("INVALID_ASSET_ISSUER");
      }
    });

    it("consistently encodes the configured network passphrase into the generated XDR", () => {
      const xdr = stellar.buildPayment(validPaymentParams);
      const networkPassphrase = config.networkPassphrase || Networks.TESTNET;
      const parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      expect(parsed).toBeDefined();
    });
  });

  describe("buildDeterministicSettlementPaymentXdr pre-build validation", () => {
    const validDeterministicParams = {
      sourcePublicKey: validSource,
      sourceSequence: "2000",
      destination: validDest,
      assetCode: "USDC",
      assetIssuer: validIssuer,
      amount: "15.0000000",
      memoCode: "DET123",
      minTime: 1700000000,
      maxTime: 1700000300,
    };

    it("generates deterministic XDR for valid parameters", () => {
      const xdr1 = buildDeterministicSettlementPaymentXdr(validDeterministicParams);
      const xdr2 = buildDeterministicSettlementPaymentXdr(validDeterministicParams);
      expect(xdr1).toBe(xdr2);

      const parsed = TransactionBuilder.fromXDR(xdr1, config.networkPassphrase || Networks.TESTNET);
      expect(parsed.source).toBe(validSource);
      expect(parsed.sequence).toBe("2001");
    });

    it("rejects invalid source public key on deterministic build", () => {
      try {
        buildDeterministicSettlementPaymentXdr({
          ...validDeterministicParams,
          sourcePublicKey: "MALFORMED_G_ADDRESS",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("INVALID_SOURCE_ACCOUNT");
      }
    });

    it("rejects invalid destination public key on deterministic build", () => {
      try {
        buildDeterministicSettlementPaymentXdr({
          ...validDeterministicParams,
          destination: "INVALID_DEST",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("INVALID_DESTINATION_ACCOUNT");
      }
    });

    it("rejects invalid asset issuer on deterministic build", () => {
      try {
        buildDeterministicSettlementPaymentXdr({
          ...validDeterministicParams,
          assetIssuer: "INVALID_ISSUER",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("INVALID_ASSET_ISSUER");
      }
    });
  });
});

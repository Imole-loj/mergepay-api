import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildChallenge,
  validateChallengeTimeBounds,
  validateChallengeHomeDomain,
  validateChallengeSignerThresholds,
  extractHomeDomain,
  parseTransaction,
  serverKeypair,
  CHALLENGE_VALIDITY_SECONDS,
} from "../../src/services/sep10";
import { config } from "../../src/config";

describe("SEP-10 Authentication Challenge Validation & Expiration (#632)", () => {
  const clientKeypair = Keypair.random();

  describe("validateChallengeTimeBounds", () => {
    it("accepts valid time bounds within current window", () => {
      const now = new Date();
      const currentSeconds = Math.floor(now.getTime() / 1000);
      const bounds = {
        minTime: currentSeconds - 10,
        maxTime: currentSeconds + CHALLENGE_VALIDITY_SECONDS,
      };

      expect(() => validateChallengeTimeBounds(bounds, now)).not.toThrow();
    });

    it("rejects expired challenge bounds", () => {
      const now = new Date();
      const currentSeconds = Math.floor(now.getTime() / 1000);
      const expiredBounds = {
        minTime: currentSeconds - 600,
        maxTime: currentSeconds - 301, // exceeds skew tolerance (300s)
      };

      expect(() => validateChallengeTimeBounds(expiredBounds, now)).toThrow();
    });

    it("rejects challenge window that is not yet valid", () => {
      const now = new Date();
      const currentSeconds = Math.floor(now.getTime() / 1000);
      const futureBounds = {
        minTime: currentSeconds + 600, // starts well in future
        maxTime: currentSeconds + 900,
      };

      expect(() => validateChallengeTimeBounds(futureBounds, now)).toThrow();
    });

    it("rejects challenge window that exceeds allowable validity duration", () => {
      const now = new Date();
      const currentSeconds = Math.floor(now.getTime() / 1000);
      const tooLongBounds = {
        minTime: currentSeconds - 10,
        maxTime: currentSeconds + CHALLENGE_VALIDITY_SECONDS + 1000,
      };

      expect(() => validateChallengeTimeBounds(tooLongBounds, now)).toThrow();
    });

    it("rejects null or unbounded timebounds", () => {
      expect(() => validateChallengeTimeBounds(null)).toThrow();
      expect(() => validateChallengeTimeBounds({ minTime: 0, maxTime: 0 })).toThrow();
    });
  });

  describe("validateChallengeHomeDomain", () => {
    it("extracts and verifies matching home domain", () => {
      const { transaction } = buildChallenge(clientKeypair.publicKey());
      const tx = parseTransaction(transaction);

      const domain = validateChallengeHomeDomain(tx, config.SEP10_HOME_DOMAIN);
      expect(domain.toLowerCase()).toBe(config.SEP10_HOME_DOMAIN.toLowerCase());
    });

    it("rejects mismatching home domain", () => {
      const { transaction } = buildChallenge(clientKeypair.publicKey());
      const tx = parseTransaction(transaction);

      expect(() => validateChallengeHomeDomain(tx, "malicious-domain.com")).toThrow();
    });

    it("extracts home domain correctly from challenge transaction", () => {
      const { transaction } = buildChallenge(clientKeypair.publicKey());
      const tx = parseTransaction(transaction);

      const extracted = extractHomeDomain(tx);
      expect(extracted?.toLowerCase()).toBe(config.SEP10_HOME_DOMAIN.toLowerCase());
    });
  });

  describe("validateChallengeSignerThresholds", () => {
    it("verifies single signer satisfying threshold 1", () => {
      const { transaction } = buildChallenge(clientKeypair.publicKey());
      const tx = parseTransaction(transaction);
      tx.sign(clientKeypair);
      const signedXdr = tx.toEnvelope().toXDR("base64");

      const signers = [
        { key: clientKeypair.publicKey(), weight: 1 },
      ];

      const validSigners = validateChallengeSignerThresholds(
        signedXdr,
        serverKeypair().publicKey(),
        1,
        signers,
        config.SEP10_HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );

      expect(validSigners).toContain(clientKeypair.publicKey());
    });

    it("verifies multisig signers satisfying threshold 2", () => {
      const signer1 = Keypair.random();
      const signer2 = Keypair.random();

      const { transaction } = buildChallenge(clientKeypair.publicKey());
      const tx = parseTransaction(transaction);
      tx.sign(signer1);
      tx.sign(signer2);
      const signedXdr = tx.toEnvelope().toXDR("base64");

      const signers = [
        { key: signer1.publicKey(), weight: 1 },
        { key: signer2.publicKey(), weight: 1 },
      ];

      const validSigners = validateChallengeSignerThresholds(
        signedXdr,
        serverKeypair().publicKey(),
        2,
        signers,
        config.SEP10_HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );

      expect(validSigners).toHaveLength(2);
      expect(validSigners).toContain(signer1.publicKey());
      expect(validSigners).toContain(signer2.publicKey());
    });

    it("rejects signatures when weight does not meet required threshold", () => {
      const signer1 = Keypair.random();

      const { transaction } = buildChallenge(clientKeypair.publicKey());
      const tx = parseTransaction(transaction);
      tx.sign(signer1); // only 1 weight provided
      const signedXdr = tx.toEnvelope().toXDR("base64");

      const signers = [
        { key: signer1.publicKey(), weight: 1 },
        { key: Keypair.random().publicKey(), weight: 1 },
      ];

      // Requires threshold 2, but only signer1 (weight 1) signed
      expect(() =>
        validateChallengeSignerThresholds(
          signedXdr,
          serverKeypair().publicKey(),
          2,
          signers,
          config.SEP10_HOME_DOMAIN,
          config.WEB_AUTH_DOMAIN
        )
      ).toThrow();
    });

    it("rejects signatures from unauthorized signers", () => {
      const unauthorizedSigner = Keypair.random();

      const { transaction } = buildChallenge(clientKeypair.publicKey());
      const tx = parseTransaction(transaction);
      tx.sign(unauthorizedSigner);
      const signedXdr = tx.toEnvelope().toXDR("base64");

      const signers = [
        { key: clientKeypair.publicKey(), weight: 1 },
      ];

      expect(() =>
        validateChallengeSignerThresholds(
          signedXdr,
          serverKeypair().publicKey(),
          1,
          signers,
          config.SEP10_HOME_DOMAIN,
          config.WEB_AUTH_DOMAIN
        )
      ).toThrow();
    });
  });
});

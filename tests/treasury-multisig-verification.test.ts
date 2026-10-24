/**
 * Issue #837: Treasury multisig transaction verification helper.
 *
 * Tests the utility functions that inspect unsigned and partially signed XDRs
 * against the expected threshold and signer configuration stored in the treasury settings.
 *
 * Verifies that:
 *  1. `verifyMultisigSignatures` correctly parses and validates XDR envelopes
 *  2. Signature verification works against authorized signers with weight tracking
 *  3. Threshold status is correctly computed from verified signature weights
 *  4. Unauthorized signatures are detected and flagged
 *  5. `analyzeMultisigRequirements` extracts threshold and signer info from unsigned XDR
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Keypair,
  TransactionBuilder,
  Account,
  Operation,
  Asset,
} from "@stellar/stellar-sdk";
import { config } from "../src/config";
import {
  verifyMultisigSignatures,
  analyzeMultisigRequirements,
} from "../src/services/treasury-multisig-verification";
import { Errors } from "../src/errors";

vi.mock("../src/services/stellar", () => {
  return {
    stellar: {
      loadAccount: vi.fn(),
      networkPassphrase: config.networkPassphrase,
    },
  };
});

import { stellar } from "../src/services/stellar";

describe("Issue #837: Treasury Multisig Transaction Verification Helper", () => {
  const treasuryKey = Keypair.random();
  const signer1 = Keypair.random();
  const signer2 = Keypair.random();
  const signer3 = Keypair.random();
  const destKey = Keypair.random();

  const authorizedSigners = new Set([
    signer1.publicKey(),
    signer2.publicKey(),
    signer3.publicKey(),
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("verifyMultisigSignatures", () => {
    it("parses a valid unsigned XDR and returns threshold information", async () => {
      (stellar.loadAccount as any).mockResolvedValue({
        exists: true,
        thresholds: { low: 1, med: 2, high: 2 },
        signers: [
          { key: signer1.publicKey(), weight: 1 },
          { key: signer2.publicKey(), weight: 1 },
          { key: signer3.publicKey(), weight: 1 },
        ],
      });

      const unsignedXdr = new TransactionBuilder(
        new Account(treasuryKey.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build()
        .toXDR();

      const result = await verifyMultisigSignatures({
        xdr: unsignedXdr,
        treasuryAccountPublicKey: treasuryKey.publicKey(),
        authorizedSigners,
      });

      expect(result.meetsThreshold).toBe(false);
      expect(result.totalWeight).toBe(0);
      expect(result.requiredWeight).toBe(2);
      expect(result.signatureCount).toBe(0);
      expect(result.sourceAccount).toBe(treasuryKey.publicKey());
    });

    it("verifies a single valid signature and tracks its weight", async () => {
      (stellar.loadAccount as any).mockResolvedValue({
        exists: true,
        thresholds: { low: 1, med: 2, high: 2 },
        signers: [
          { key: signer1.publicKey(), weight: 1 },
          { key: signer2.publicKey(), weight: 1 },
          { key: signer3.publicKey(), weight: 1 },
        ],
      });

      const tx = new TransactionBuilder(
        new Account(treasuryKey.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build();

      tx.sign(signer1);
      const signedXdr = tx.toXDR();

      const result = await verifyMultisigSignatures({
        xdr: signedXdr,
        treasuryAccountPublicKey: treasuryKey.publicKey(),
        authorizedSigners,
      });

      expect(result.meetsThreshold).toBe(false);
      expect(result.totalWeight).toBe(1);
      expect(result.signatureCount).toBe(1);
      expect(result.signatures).toHaveLength(1);
      expect(result.signatures[0].publicKey).toBe(signer1.publicKey());
      expect(result.signatures[0].verified).toBe(true);
      expect(result.signatures[0].weight).toBe(1);
    });

    it("verifies multiple signatures and correctly sums weights to meet threshold", async () => {
      (stellar.loadAccount as any).mockResolvedValue({
        exists: true,
        thresholds: { low: 1, med: 2, high: 2 },
        signers: [
          { key: signer1.publicKey(), weight: 1 },
          { key: signer2.publicKey(), weight: 1 },
          { key: signer3.publicKey(), weight: 1 },
        ],
      });

      const tx = new TransactionBuilder(
        new Account(treasuryKey.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build();

      tx.sign(signer1, signer2);
      const signedXdr = tx.toXDR();

      const result = await verifyMultisigSignatures({
        xdr: signedXdr,
        treasuryAccountPublicKey: treasuryKey.publicKey(),
        authorizedSigners,
      });

      expect(result.meetsThreshold).toBe(true);
      expect(result.totalWeight).toBe(2);
      expect(result.signatureCount).toBe(2);
    });

    it("rejects a signature from an unauthorized signer", async () => {
      const unauthorizedKey = Keypair.random();

      (stellar.loadAccount as any).mockResolvedValue({
        exists: true,
        thresholds: { low: 1, med: 2, high: 2 },
        signers: [
          { key: signer1.publicKey(), weight: 1 },
          { key: signer2.publicKey(), weight: 1 },
          { key: signer3.publicKey(), weight: 1 },
        ],
      });

      const tx = new TransactionBuilder(
        new Account(treasuryKey.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build();

      tx.sign(unauthorizedKey);
      const signedXdr = tx.toXDR();

      const result = await verifyMultisigSignatures({
        xdr: signedXdr,
        treasuryAccountPublicKey: treasuryKey.publicKey(),
        authorizedSigners,
      });

      expect(result.meetsThreshold).toBe(false);
      expect(result.totalWeight).toBe(0);
      expect(result.signatureCount).toBe(0);
      expect(result.signatures).toHaveLength(1);
      expect(result.signatures[0].publicKey).toBe("unknown");
      expect(result.signatures[0].verified).toBe(false);
    });

    it("rejects an XDR with mismatched source account", async () => {
      const wrongSource = Keypair.random();

      (stellar.loadAccount as any).mockResolvedValue({
        exists: true,
        thresholds: { low: 1, med: 2, high: 2 },
        signers: [],
      });

      const unsignedXdr = new TransactionBuilder(
        new Account(wrongSource.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build()
        .toXDR();

      await expect(
        verifyMultisigSignatures({
          xdr: unsignedXdr,
          treasuryAccountPublicKey: treasuryKey.publicKey(),
          authorizedSigners,
        })
      ).rejects.toMatchObject({
        code: "SOURCE_ACCOUNT_MISMATCH",
      });
    });

    it("rejects an XDR that cannot be parsed", async () => {
      await expect(
        verifyMultisigSignatures({
          xdr: "invalid-xdr-string",
          treasuryAccountPublicKey: treasuryKey.publicKey(),
          authorizedSigners,
        })
      ).rejects.toMatchObject({
        code: "XDR_PARSE_FAILED",
      });
    });

    it("rejects verification for an unfunded treasury account", async () => {
      (stellar.loadAccount as any).mockResolvedValue({
        exists: false,
      });

      const unsignedXdr = new TransactionBuilder(
        new Account(treasuryKey.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build()
        .toXDR();

      await expect(
        verifyMultisigSignatures({
          xdr: unsignedXdr,
          treasuryAccountPublicKey: treasuryKey.publicKey(),
          authorizedSigners,
        })
      ).rejects.toMatchObject({
        code: "TREASURY_UNFUNDED",
      });
    });

    it("correctly handles signer weight configuration (high weight signer)", async () => {
      (stellar.loadAccount as any).mockResolvedValue({
        exists: true,
        thresholds: { low: 1, med: 2, high: 3 },
        signers: [
          { key: signer1.publicKey(), weight: 2 },
          { key: signer2.publicKey(), weight: 1 },
          { key: signer3.publicKey(), weight: 1 },
        ],
      });

      const tx = new TransactionBuilder(
        new Account(treasuryKey.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build();

      tx.sign(signer1);
      const signedXdr = tx.toXDR();

      const result = await verifyMultisigSignatures({
        xdr: signedXdr,
        treasuryAccountPublicKey: treasuryKey.publicKey(),
        authorizedSigners,
      });

      expect(result.meetsThreshold).toBe(false);
      expect(result.totalWeight).toBe(2);
      expect(result.requiredWeight).toBe(3);
      expect(result.signatures[0].weight).toBe(2);
    });
  });

  describe("analyzeMultisigRequirements", () => {
    it("extracts threshold and signer information from unsigned XDR", async () => {
      (stellar.loadAccount as any).mockResolvedValue({
        exists: true,
        thresholds: { low: 1, med: 2, high: 2 },
        signers: [
          { key: signer1.publicKey(), weight: 1 },
          { key: signer2.publicKey(), weight: 1 },
          { key: signer3.publicKey(), weight: 1 },
        ],
      });

      const unsignedXdr = new TransactionBuilder(
        new Account(treasuryKey.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build()
        .toXDR();

      const result = await analyzeMultisigRequirements(
        unsignedXdr,
        treasuryKey.publicKey()
      );

      expect(result.requiredWeight).toBe(2);
      expect(result.sourceAccount).toBe(treasuryKey.publicKey());
      expect(result.availableSigners).toHaveLength(3);
      expect(result.availableSigners[0]).toMatchObject({
        publicKey: signer1.publicKey(),
        weight: 1,
      });
    });

    it("rejects an XDR with mismatched source account", async () => {
      const wrongSource = Keypair.random();

      (stellar.loadAccount as any).mockResolvedValue({
        exists: true,
        thresholds: { low: 1, med: 2, high: 2 },
        signers: [],
      });

      const unsignedXdr = new TransactionBuilder(
        new Account(wrongSource.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build()
        .toXDR();

      await expect(
        analyzeMultisigRequirements(unsignedXdr, treasuryKey.publicKey())
      ).rejects.toMatchObject({
        code: "SOURCE_ACCOUNT_MISMATCH",
      });
    });

    it("rejects an XDR that cannot be parsed", async () => {
      await expect(
        analyzeMultisigRequirements("invalid-xdr", treasuryKey.publicKey())
      ).rejects.toMatchObject({
        code: "XDR_PARSE_FAILED",
      });
    });

    it("rejects analysis for an unfunded treasury account", async () => {
      (stellar.loadAccount as any).mockResolvedValue({
        exists: false,
      });

      const unsignedXdr = new TransactionBuilder(
        new Account(treasuryKey.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build()
        .toXDR();

      await expect(
        analyzeMultisigRequirements(unsignedXdr, treasuryKey.publicKey())
      ).rejects.toMatchObject({
        code: "TREASURY_UNFUNDED",
      });
    });
  });
});

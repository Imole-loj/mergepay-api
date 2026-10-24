import {
  Account,
  Asset,
  BASE_FEE,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { config } from "../config";
import { memoText } from "./stellar";
/**
 * Bind a wallet-signed envelope to the settlement intent the API created.
 *
 * Mergepay never holds a private key: it builds an unsigned XDR, hands it to a
 * wallet, and gets something back. Everything between those two moments is
 * outside our control — a compromised or buggy wallet can return a *validly
 * signed* transaction that pays a different account, a different asset, or a
 * different amount, and it would look perfectly legitimate to Horizon.
 *
 * The defence is that the intent is already persisted. This module rebuilds the
 * expectation from the stored settlement row — never from anything the client
 * sent — and checks the envelope against it before submission. A mismatch stops
 * the request: nothing reaches Horizon, and the settlement is not advanced.
 *
 * Callers:
 *  - `POST /settlements/:id/confirm`, before the signed XDR is persisted;
 *  - the worker, again at submission time, so an envelope that was persisted by
 *    an older code path is still re-checked against its own intent.
 */
import { Errors } from "../errors";
import {
  validateSignedXdr,
  type PaymentExpectation,
  type SignedXdrValidation,
} from "./stellar";

/** The persisted fields an intent is rebuilt from. */
export interface SettlementIntentRecord {
  shortCode: string;
  amount: unknown;
  assetCode: string;
  assetIssuer: string | null;
  /** Server-controlled signing deadline; null on rows predating expiry tracking. */
  expiresAt?: Date | null;
  /** Sequence used to build the persisted unsigned payment intent, when stored. */
  sourceSequence?: string;
  from: { stellarPublicKey: string };
  to: { stellarPublicKey: string };
}

/**
 * Rebuild the payment this settlement authorized.
 *
 * Every field comes from the settlement row. The memo code is the settlement's
 * own short code, which is what ties an on-chain payment back to this record.
 */
export function settlementPaymentIntent(
  settlement: SettlementIntentRecord
): PaymentExpectation {
  return {
    sourcePublicKey: settlement.from.stellarPublicKey,
    destination: settlement.to.stellarPublicKey,
    asset: { code: settlement.assetCode, issuer: settlement.assetIssuer },
    amount: String(settlement.amount),
    memoCode: settlement.shortCode,
    sourceSequence: settlement.sourceSequence,
    expiresAt: settlement.expiresAt ?? null,
    resource: "settlement",
  };
}

/**
 * Validate a wallet-signed envelope against a settlement's own intent.
 *
 * Covers, in this order: parseability (and rejection of fee-bump wrappers), the
 * transaction's validity window against the recorded expiry, transaction
 * source, operation count, fee bounds, operation type and source, destination,
 * asset code and issuer, amount, memo, and finally a signature that verifies
 * against the source account for the configured network passphrase.
 *
 * Throws `AppError` (400 `XDR_MISMATCH`, `XDR_MALFORMED`, or `INTENT_EXPIRED`)
 * with a stable message. The envelope itself is never echoed back or included
 * in the error, so a rejection reveals which *field* diverged and nothing else.
 */
export function validateSettlementXdr(
  signedXdr: string,
  settlement: SettlementIntentRecord
): SignedXdrValidation {
  return validateSignedXdr(signedXdr, settlementPaymentIntent(settlement));
}

/** Statuses from which a signed envelope may still be accepted. */
const CONFIRMABLE_STATUSES = new Set(["pending", "failed"]);

/**
 * Whether a settlement is still awaiting a signed envelope. A settlement that
 * has already been submitted or finished must not accept a new one — that is
 * what would turn a retry into a second payment.
 */
export function isConfirmable(status: string): boolean {
  return CONFIRMABLE_STATUSES.has(status);
}

/** Reject a settlement whose intent is no longer live, before any validation. */
export function assertSettlementConfirmable(settlement: {
  status: string;
}): void {
  if (settlement.status === "confirmed" || settlement.status === "completed") {
    throw Errors.conflict(
      "already_settled",
      "This settlement has already been completed"
    );
  }
}


export interface DeterministicPaymentParams {
  sourcePublicKey: string;
  sourceSequence: string;
  destination: string;
  assetCode: string;
  assetIssuer: string | null;
  amount: string;
  memoCode: string;
  validitySeconds?: number;
  minTime?: number;
  maxTime?: number;
  feeStroops?: number | string;
}

/**
 * Deterministically constructs an unsigned Stellar payment XDR.
 * Given identical inputs (including fixed timebounds), it yields identical XDR bytes
 * and transaction hashes without requiring or handling any private key material.
 */
export function buildDeterministicSettlementPaymentXdr(
  params: DeterministicPaymentParams
): string {
  // Validate signer and account constraints (#880)
  if (!params.sourcePublicKey || !StrKey.isValidEd25519PublicKey(params.sourcePublicKey)) {
    throw Errors.badRequest(
      "invalid_source_account",
      "Source account must be a valid Stellar public key (G...)"
    );
  }
  if (!params.destination || !StrKey.isValidEd25519PublicKey(params.destination)) {
    throw Errors.badRequest(
      "invalid_destination_account",
      "Destination must be a valid Stellar public key (G...)"
    );
  }
  if (!params.sourceSequence || !/^\d+$/.test(String(params.sourceSequence))) {
    throw Errors.badRequest(
      "invalid_sequence",
      "Source sequence must be a valid numeric sequence string"
    );
  }
  if (params.assetIssuer && !StrKey.isValidEd25519PublicKey(params.assetIssuer)) {
    throw Errors.badRequest(
      "invalid_asset_issuer",
      "Asset issuer must be a valid Stellar public key (G...)"
    );
  }

  const networkPassphrase = config.networkPassphrase || Networks.TESTNET;
  const source = new Account(params.sourcePublicKey, params.sourceSequence);
  const fee = params.feeStroops
    ? String(params.feeStroops)
    : String(Number(BASE_FEE) * 2);

  const builder = new TransactionBuilder(source, {
    fee,
    networkPassphrase,
    timebounds:
      params.minTime !== undefined && params.maxTime !== undefined
        ? { minTime: params.minTime, maxTime: params.maxTime }
        : undefined,
  })
    .addOperation(
      Operation.payment({
        destination: params.destination,
        asset:
          params.assetCode.toUpperCase() === "XLM" || !params.assetIssuer
            ? Asset.native()
            : new Asset(params.assetCode, params.assetIssuer),
        amount: params.amount,
      })
    )
    .addMemo(Memo.text(memoText(params.memoCode)));

  if (params.minTime === undefined || params.maxTime === undefined) {
    builder.setTimeout(params.validitySeconds ?? 300);
  }

  const tx = builder.build();
  return tx.toXDR();
}

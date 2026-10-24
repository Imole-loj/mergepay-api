/**
 * Unified Authentication Service — Issue #885.
 *
 * Coordinates SEP-10 Stellar Web Authentication challenge lifecycle and JWT session
 * token verification. Distinguishes granular failure modes (expired challenges,
 * invalid signatures, domain mismatches, network mismatches) while preventing
 * sensitive key material or internal stack traces from leaking to clients.
 */

import { AppError, ErrorCode, Errors } from "../errors";
import {
  authenticateChallenge as sep10Authenticate,
  buildChallenge as sep10Build,
  verifyChallenge as sep10Verify,
  validateChallengeTimeBounds,
  cleanupExpiredChallenges,
  serverKeypair,
  CHALLENGE_VALIDITY_SECONDS,
  type VerifiedChallenge,
} from "./sep10";
import { signToken as jwtSign, verifyToken as jwtVerify, type AuthUser, type JwtClaims, jwtClaimsSchema } from "./jwt";

export {
  serverKeypair,
  CHALLENGE_VALIDITY_SECONDS,
  cleanupExpiredChallenges,
  validateChallengeTimeBounds,
  jwtClaimsSchema,
};
export type { VerifiedChallenge, AuthUser, JwtClaims };

/**
 * Classify any challenge verification error into a secure, explicit AppError
 * that does not leak internal stack traces or cryptographic secrets.
 */
export function classifySep10Error(error: unknown, account?: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  const lowerMsg = message.toLowerCase();

  if (lowerMsg.includes("expired") || lowerMsg.includes("timebound") || lowerMsg.includes("max_time")) {
    return Errors.challengeExpired(
      "Authentication challenge has expired. Request a new challenge and sign it promptly.",
      { challengeValiditySeconds: CHALLENGE_VALIDITY_SECONDS }
    );
  }

  if (lowerMsg.includes("not yet valid") || lowerMsg.includes("min_time") || lowerMsg.includes("not_yet_valid")) {
    return Errors.challengeNotYetValid(
      "Authentication challenge is not valid yet. Request a new challenge and sign it promptly."
    );
  }

  if (lowerMsg.includes("window") && (lowerMsg.includes("long") || lowerMsg.includes("exceeds"))) {
    return Errors.challengeWindowTooLong(
      "Authentication challenge window is longer than this server issues. Request a new challenge."
    );
  }

  if (
    lowerMsg.includes("homedomain") ||
    lowerMsg.includes("home domain") ||
    lowerMsg.includes("domain mismatch") ||
    lowerMsg.includes("domain")
  ) {
    return Errors.challengeHomeDomainMismatch(
      "Authentication challenge was issued for a different home domain. Request a new challenge from this server."
    );
  }

  if (lowerMsg.includes("network") || lowerMsg.includes("passphrase")) {
    return Errors.challengeNetworkMismatch(
      "Authentication challenge was issued for a different Stellar network. Request a new challenge from this server and sign it for its network."
    );
  }

  if (
    lowerMsg.includes("signature") ||
    lowerMsg.includes("signer") ||
    lowerMsg.includes("threshold") ||
    lowerMsg.includes("verify")
  ) {
    return Errors.challengeSignatureInvalid(
      "Challenge signature verification failed. Ensure the challenge is signed by the account's signing key(s) before submitting."
    );
  }

  return Errors.invalidChallenge();
}

/**
 * Builds an unsigned SEP-10 challenge transaction for the specified account.
 */
export function buildChallenge(account: string): {
  transaction: string;
  networkPassphrase: string;
} {
  return sep10Build(account);
}

/**
 * Verifies a signed SEP-10 challenge transaction, catching and classifying
 * failures into explicit, client-safe AppErrors.
 */
export async function verifyChallenge(signedXdr: string): Promise<string> {
  try {
    return await sep10Verify(signedXdr);
  } catch (error) {
    throw classifySep10Error(error);
  }
}

/**
 * Authenticates a signed SEP-10 challenge transaction, returning the verified
 * account and the challenge hash identifier.
 */
export async function authenticateChallenge(signedXdr: string): Promise<VerifiedChallenge> {
  try {
    return await sep10Authenticate(signedXdr);
  } catch (error) {
    throw classifySep10Error(error);
  }
}

/**
 * Mint a session token for an authenticated user.
 */
export function signToken(user: AuthUser, opts?: { jwtid?: string }): string {
  return jwtSign(user, opts);
}

/**
 * Verify an access token and return the authenticated user identity.
 */
export function verifyToken(token: string): AuthUser {
  return jwtVerify(token);
}

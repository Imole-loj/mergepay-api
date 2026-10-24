/**
 * Zod request validation schemas for group creation, update, and member invitation endpoints (#897).
 *
 * Enforces strict input validation on group management payloads, ensuring valid identifiers,
 * valid Stellar public keys for member invitations and treasury config, closed role enums,
 * and rejection of unrecognized payload properties.
 */
export * from "./groups";

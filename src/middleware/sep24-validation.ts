/**
 * Fastify request validation middleware for SEP-24 deposit and withdrawal flows (#631).
 *
 * Enforces strict input validation on incoming query parameters and JSON bodies
 * using Zod before invoking underlying business logic or communicating with
 * the Stellar anchor service layer.
 */
import type { preHandlerHookHandler } from "fastify";
import { validateRequest } from "./validate-request";
import {
  sep24DepositRequestSchema,
  sep24WithdrawRequestSchema,
  sep24InitQuerySchema,
} from "../validations/sep24";

/**
 * Validation middleware for SEP-24 deposit endpoints.
 * Validates optional init query parameters and strict deposit request body.
 */
export const validateSep24DepositMiddleware: preHandlerHookHandler = validateRequest({
  query: sep24InitQuerySchema,
  body: sep24DepositRequestSchema,
});

/**
 * Validation middleware for SEP-24 withdrawal endpoints.
 * Validates optional init query parameters and strict withdrawal request body (with required amount).
 */
export const validateSep24WithdrawMiddleware: preHandlerHookHandler = validateRequest({
  query: sep24InitQuerySchema,
  body: sep24WithdrawRequestSchema,
});

/**
 * Factory for creating custom SEP-24 request validation middlewares.
 */
export function createSep24ValidationMiddleware(kind: "deposit" | "withdrawal"): preHandlerHookHandler {
  return kind === "deposit" ? validateSep24DepositMiddleware : validateSep24WithdrawMiddleware;
}

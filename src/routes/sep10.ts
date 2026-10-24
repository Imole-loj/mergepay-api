/**
 * Dedicated SEP-10 authentication route module with Zod validation middleware (#875).
 *
 * Implements Zod validation preHandler hooks to ensure invalid requests, malformed
 * public keys, and non-canonical base64 XDR envelopes are rejected with standard
 * 400 VALIDATION_ERROR before reaching cryptographic challenge handling.
 */
import type { FastifyInstance } from "fastify";
import { buildChallenge, authenticateChallenge } from "../services/sep10";
import {
  sep10ChallengeRequestSchema,
  sep10ChallengeQuerySchema,
  sep10VerifyRequestSchema,
  validateSep10ChallengeHook,
  validateSep10VerifyHook,
} from "../validations/sep10";
import { openApiBody, openApiErrorResponses, openApiResponse } from "../lib/openapi";

export {
  validateSep10ChallengeHook,
  validateSep10VerifyHook,
};

export default async function sep10Routes(app: FastifyInstance) {
  // GET /sep10/challenge with preHandler query validation
  app.get(
    "/sep10/challenge",
    {
      preHandler: [validateSep10ChallengeHook],
      schema: {
        tags: ["Auth"],
        summary: "Request SEP-10 challenge via query parameter",
        description: "Validates account query parameter via Zod and issues challenge transaction.",
        response: {
          ...openApiResponse({
            transaction: { type: "string" },
            networkPassphrase: { type: "string" },
          }),
          ...openApiErrorResponses(400, 429),
        },
      },
    },
    async (req: any) => {
      const { account } = req.sep10Challenge;
      return buildChallenge(account);
    }
  );

  // POST /sep10/challenge with preHandler body validation
  app.post(
    "/sep10/challenge",
    {
      preHandler: [validateSep10ChallengeHook],
      schema: {
        tags: ["Auth"],
        summary: "Request SEP-10 challenge via request body",
        description: "Validates account payload via Zod and issues challenge transaction.",
        body: openApiBody(sep10ChallengeRequestSchema, { enforce: false }),
        response: {
          ...openApiResponse({
            transaction: { type: "string" },
            networkPassphrase: { type: "string" },
          }),
          ...openApiErrorResponses(400, 429),
        },
      },
    },
    async (req: any) => {
      const { account } = req.sep10Challenge;
      return buildChallenge(account);
    }
  );

  // POST /sep10/verify with preHandler body validation
  app.post(
    "/sep10/verify",
    {
      preHandler: [validateSep10VerifyHook],
      schema: {
        tags: ["Auth"],
        summary: "Verify signed SEP-10 challenge transaction",
        description: "Validates transaction XDR via Zod before verifying signatures.",
        body: openApiBody(sep10VerifyRequestSchema, { enforce: false }),
        response: {
          ...openApiResponse({
            token: { type: "string" },
          }),
          ...openApiErrorResponses(400, 401, 429),
        },
      },
    },
    async (req: any) => {
      const { transaction } = req.sep10Verify;
      return authenticateChallenge(transaction);
    }
  );
}

/**
 * Structured JSON audit logging middleware for state-changing group and expense operations (#903).
 *
 * Automatically records actor addresses, client IP, action types, timestamps,
 * and target resource IDs for POST, PUT, PATCH, and DELETE requests targeting
 * groups, group members, expenses, and settlements.
 */
import type { FastifyReply, FastifyRequest, onResponseHookHandler } from "fastify";
import {
  auditGroupExpenseMutation,
  type AuditOutcome,
} from "../services/audit";
import { STATE_CHANGING_METHODS } from "./audit";

export interface GroupExpenseAuditOptions {
  action: string;
  entityType: "group" | "expense" | "settlement" | "group_member";
  getEntityId?: (req: FastifyRequest) => string | undefined;
  getGroupId?: (req: FastifyRequest) => string | undefined;
  outcome?: AuditOutcome;
  metadata?: (req: FastifyRequest) => Record<string, unknown>;
}

export function groupExpenseAudit(
  options: GroupExpenseAuditOptions
): onResponseHookHandler {
  return function groupExpenseAuditHook(
    this: unknown,
    req: FastifyRequest,
    reply: FastifyReply,
    done: () => void
  ): void {
    done();
    try {
      if (!STATE_CHANGING_METHODS.has(req.method)) return;
      if (reply.statusCode < 200 || reply.statusCode >= 300) return;

      const params = req.params as Record<string, string | undefined> | undefined;
      const groupId =
        options.getGroupId?.(req) ??
        params?.groupId ??
        params?.id ??
        "unknown";

      const entityId =
        options.getEntityId?.(req) ??
        params?.expenseId ??
        params?.memberId ??
        params?.settlementId ??
        params?.id ??
        "unknown";

      const actorPublicKey =
        (req.user as { stellarPublicKey?: string } | undefined)?.stellarPublicKey ??
        (req.headers["x-stellar-public-key"] as string | undefined) ??
        null;

      const rawForwarded = req.headers["x-forwarded-for"];
      const clientIp =
        (typeof rawForwarded === "string" ? rawForwarded.split(",")[0].trim() : null) ||
        req.ip ||
        null;

      void auditGroupExpenseMutation({
        userId: req.user?.id ?? null,
        actorPublicKey,
        clientIp,
        groupId,
        action: options.action,
        entityType: options.entityType,
        entityId,
        outcome: options.outcome ?? "success",
        metadata: {
          method: req.method,
          route: req.routeOptions.url ?? null,
          statusCode: reply.statusCode,
          ...(options.metadata?.(req) ?? {}),
        },
      });
    } catch {
      // Best-effort auditing must never interrupt HTTP flow
    }
  };
}

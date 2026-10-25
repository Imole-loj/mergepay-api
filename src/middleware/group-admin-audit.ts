/**
 * Audit logging middleware for state-changing group admin actions — Issue #801.
 *
 * Automatically captures actor ID, action type, target resource, and timestamp
 * for state-changing group administrator operations (e.g. member removal, settings
 * updates, role modifications) with sanitized metadata, executing asynchronously
 * without blocking response delivery.
 */
import type { FastifyReply, FastifyRequest, onResponseHookHandler } from "fastify";
import { auditGroupAdminAction } from "../services/audit";
import { STATE_CHANGING_METHODS } from "./audit";
import { sanitizeAuditMetadata } from "../lib/audit-logger";

export interface GroupAdminAuditOptions {
  action: string;
  resourceType?: string;
  getGroupId?: (req: FastifyRequest) => string | undefined;
  getResourceId?: (req: FastifyRequest) => string | undefined;
  getMetadata?: (req: FastifyRequest) => Record<string, unknown>;
}

/**
 * Fastify onResponse hook recording group admin mutations.
 */
export function groupAdminAudit(
  options: GroupAdminAuditOptions
): onResponseHookHandler {
  return function groupAdminAuditHook(
    this: unknown,
    req: FastifyRequest,
    reply: FastifyReply,
    done: () => void
  ): void {
    // Release response immediately to guarantee non-blocking asynchronous execution
    done();

    try {
      if (!STATE_CHANGING_METHODS.has(req.method)) return;
      if (reply.statusCode < 200 || reply.statusCode >= 300) return;

      const actorId = req.user?.id;
      if (!actorId) return;

      const params = req.params as Record<string, string | undefined> | undefined;
      const groupId =
        options.getGroupId?.(req) ??
        params?.groupId ??
        params?.id ??
        "unknown";

      const resourceId =
        options.getResourceId?.(req) ??
        params?.memberId ??
        params?.expenseId ??
        params?.id ??
        groupId;

      const actorPublicKey = req.user?.stellarPublicKey ?? null;
      const rawMetadata = options.getMetadata?.(req) ?? {};
      const metadata = {
        method: req.method,
        route: req.routeOptions.url ?? req.url.split("?")[0],
        statusCode: reply.statusCode,
        ...(sanitizeAuditMetadata(rawMetadata) as Record<string, unknown>),
      };

      // Dispatched asynchronously without blocking the request response cycle
      void auditGroupAdminAction({
        actorId,
        actorPublicKey,
        groupId,
        action: options.action,
        targetResourceId: resourceId,
        targetResourceType: options.resourceType ?? "group",
        metadata,
      });
    } catch {
      // Swallowed: audit recording must never impact delivered responses
    }
  };
}

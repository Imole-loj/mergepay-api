import { Errors } from "../errors";
import {
  createGroupSchema,
  updateGroupSchema,
  GROUP_CURRENCIES,
  groupCurrencySchema,
  type CreateGroupInput,
  type UpdateGroupInput,
  type GroupCurrency,
} from "../schemas/groups";
import {
  requireMembership,
  requireAdmin,
  requireActiveAdmin,
  type MembershipContext,
} from "./access";
import { audit } from "./audit";
import { AuditAction } from "./audit-actions";
import { prisma } from "../db";

/**
 * Validate a group creation request payload against the Zod schema.
 * Throws AppError 400 Bad Request on validation failure with a clear message.
 */
export function validateCreateGroupPayload(payload: unknown): CreateGroupInput {
  const result = createGroupSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const pathStr = issue?.path.join(".") || "payload";
    throw Errors.badRequest("VALIDATION_ERROR", `${pathStr}: ${issue?.message ?? "Invalid group payload"}`);
  }
  return result.data;
}

/**
 * Validate a group update request payload against the Zod schema.
 * Throws AppError 400 Bad Request on validation failure with a clear message.
 */
export function validateUpdateGroupPayload(payload: unknown): UpdateGroupInput {
  const result = updateGroupSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const pathStr = issue?.path.join(".") || "payload";
    throw Errors.badRequest("VALIDATION_ERROR", `${pathStr}: ${issue?.message ?? "Invalid group update payload"}`);
  }
  return result.data;
}

/**
 * Verify that a user is an administrator of a group for sensitive treasury operations (#908).
 *
 * Checks database membership and admin role. If authorized, records an audit log
 * and returns the MembershipContext. If unauthorized, records a failed audit attempt
 * and throws AppError 403 Forbidden (or 404 if the group doesn't exist).
 */
export async function assertGroupAdmin(
  userId: string,
  groupId: string,
  options: { active?: boolean } = {}
): Promise<MembershipContext> {
  try {
    const ctx = options.active
      ? await requireActiveAdmin(groupId, userId, prisma)
      : await requireAdmin(groupId, userId, prisma);

    return ctx;
  } catch (err) {
    // Record audit event for unauthorized or failed access attempt
    void audit({
      userId,
      groupId,
      action: "treasury.signer_validation",
      entityType: "group_treasury",
      entityId: groupId,
      outcome: "failure",
      metadata: {
        error: err instanceof Error ? err.message : "unauthorized",
        attemptedRole: "admin",
      },
    });
    throw err;
  }
}

export {
  createGroupSchema,
  updateGroupSchema,
  GROUP_CURRENCIES,
  groupCurrencySchema,
  type CreateGroupInput,
  type UpdateGroupInput,
  type GroupCurrency,
};

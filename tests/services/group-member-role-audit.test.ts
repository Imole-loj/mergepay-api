import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(async ({ data }: any) => ({ ...data })),
    count: vi.fn(async () => 0),
  });

  const prisma: any = {
    group: model(),
    groupMember: model(),
    auditLog: model(),
    $transaction: vi.fn(async (fn: any) =>
      typeof fn === "function" ? fn(h.prisma) : Promise.all(fn)
    ),
  };

  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import { modifyGroupMemberRole } from "../../src/services/groups";
import { AuditAction } from "../../src/services/audit-actions";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const GROUP_ID = "group_audit_test";
const ACTOR_ADMIN_ID = "user_admin_actor";
const TARGET_USER_ID = "user_target_member";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function authHeader(userId = ACTOR_ADMIN_ID) {
  return {
    authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: PUBLIC_KEY })}`,
  };
}

describe("Group Member Role Audit Logging (#876)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    if (!app) app = await buildApp();

    prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID, name: "Alpha Squad" });
    prisma.auditLog.create.mockResolvedValue({ id: "audit_log_123" });
  });

  describe("modifyGroupMemberRole service function", () => {
    it("writes an audit log entry with previous and new role when promoting member to admin", async () => {
      prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
        const userId = where.groupId_userId.userId;
        if (userId === ACTOR_ADMIN_ID) {
          return { id: "mem_actor", groupId: GROUP_ID, userId: ACTOR_ADMIN_ID, role: "admin", joinedAt: new Date() };
        }
        if (userId === TARGET_USER_ID) {
          return { id: "mem_target", groupId: GROUP_ID, userId: TARGET_USER_ID, role: "member", joinedAt: new Date() };
        }
        return null;
      });

      prisma.groupMember.update.mockResolvedValue({
        id: "mem_target",
        groupId: GROUP_ID,
        userId: TARGET_USER_ID,
        role: "admin",
        joinedAt: new Date(),
      });

      const result = await modifyGroupMemberRole({
        actorUserId: ACTOR_ADMIN_ID,
        groupId: GROUP_ID,
        targetUserId: TARGET_USER_ID,
        newRole: "admin",
      });

      expect(result.changed).toBe(true);
      expect(result.previousRole).toBe("member");
      expect(result.newRole).toBe("admin");

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const auditCall = prisma.auditLog.create.mock.calls[0][0];
      expect(auditCall.data).toMatchObject({
        userId: ACTOR_ADMIN_ID,
        groupId: GROUP_ID,
        action: AuditAction.GROUP_MEMBER_ROLE_CHANGE,
        entityType: "group_member",
        entityId: TARGET_USER_ID,
        metadata: {
          targetUserId: TARGET_USER_ID,
          previousRole: "member",
          newRole: "admin",
        },
      });
    });

    it("writes an audit log entry when demoting an admin to member if another admin remains", async () => {
      prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
        const userId = where.groupId_userId.userId;
        return { id: "mem_1", groupId: GROUP_ID, userId, role: "admin", joinedAt: new Date() };
      });
      // 2 admins remain
      prisma.groupMember.count.mockResolvedValue(2);

      prisma.groupMember.update.mockResolvedValue({
        id: "mem_target",
        groupId: GROUP_ID,
        userId: TARGET_USER_ID,
        role: "member",
        joinedAt: new Date(),
      });

      const result = await modifyGroupMemberRole({
        actorUserId: ACTOR_ADMIN_ID,
        groupId: GROUP_ID,
        targetUserId: TARGET_USER_ID,
        newRole: "member",
      });

      expect(result.changed).toBe(true);
      expect(result.previousRole).toBe("admin");
      expect(result.newRole).toBe("member");

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const auditCall = prisma.auditLog.create.mock.calls[0][0];
      expect(auditCall.data.metadata).toMatchObject({
        targetUserId: TARGET_USER_ID,
        previousRole: "admin",
        newRole: "member",
      });
    });

    it("refuses to demote the last remaining admin and emits no audit entry", async () => {
      prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
        const userId = where.groupId_userId.userId;
        return { id: "mem_1", groupId: GROUP_ID, userId, role: "admin", joinedAt: new Date() };
      });
      // Only 1 admin remains
      prisma.groupMember.count.mockResolvedValue(1);

      await expect(
        modifyGroupMemberRole({
          actorUserId: ACTOR_ADMIN_ID,
          groupId: GROUP_ID,
          targetUserId: TARGET_USER_ID,
          newRole: "member",
        })
      ).rejects.toThrow("Cannot remove the only admin from a group");

      expect(prisma.groupMember.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("is idempotent and writes no audit log when the new role equals the existing role", async () => {
      prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
        const userId = where.groupId_userId.userId;
        if (userId === ACTOR_ADMIN_ID) {
          return { id: "mem_actor", groupId: GROUP_ID, userId: ACTOR_ADMIN_ID, role: "admin", joinedAt: new Date() };
        }
        return { id: "mem_target", groupId: GROUP_ID, userId: TARGET_USER_ID, role: "member", joinedAt: new Date() };
      });

      const result = await modifyGroupMemberRole({
        actorUserId: ACTOR_ADMIN_ID,
        groupId: GROUP_ID,
        targetUserId: TARGET_USER_ID,
        newRole: "member",
      });

      expect(result.changed).toBe(false);
      expect(prisma.groupMember.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe("API Route Integration: PATCH /groups/:id/members/:memberId", () => {
    it("successfully writes an audit log when member is updated via PATCH alias", async () => {
      const now = new Date();
      prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
        const userId = where?.groupId_userId?.userId;
        if (userId === ACTOR_ADMIN_ID) {
          return {
            id: "mem_actor",
            groupId: GROUP_ID,
            userId: ACTOR_ADMIN_ID,
            role: "admin",
            joinedAt: now,
            user: { id: ACTOR_ADMIN_ID, stellarPublicKey: PUBLIC_KEY, createdAt: now },
          };
        }
        return {
          id: "mem_target",
          groupId: GROUP_ID,
          userId: TARGET_USER_ID,
          role: "member",
          joinedAt: now,
          user: { id: TARGET_USER_ID, stellarPublicKey: PUBLIC_KEY, createdAt: now },
        };
      });

      prisma.groupMember.findFirst.mockImplementation(async ({ where }: any) => {
        const userId = where?.userId;
        if (userId === ACTOR_ADMIN_ID) {
          return {
            id: "mem_actor",
            groupId: GROUP_ID,
            userId: ACTOR_ADMIN_ID,
            role: "admin",
            joinedAt: now,
            user: { id: ACTOR_ADMIN_ID, stellarPublicKey: PUBLIC_KEY, createdAt: now },
          };
        }
        return null;
      });

      prisma.groupMember.update.mockResolvedValue({
        id: "mem_target",
        groupId: GROUP_ID,
        userId: TARGET_USER_ID,
        role: "admin",
        joinedAt: now,
        user: {
          id: TARGET_USER_ID,
          stellarPublicKey: PUBLIC_KEY,
          createdAt: now,
        },
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${GROUP_ID}/members/${TARGET_USER_ID}`,
        headers: authHeader(ACTOR_ADMIN_ID),
        payload: { role: "admin" },
      });

      expect(res.statusCode).toBe(200);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const auditData = prisma.auditLog.create.mock.calls[0][0].data;
      expect(auditData.action).toBe(AuditAction.GROUP_MEMBER_ROLE_CHANGE);
      expect(auditData.userId).toBe(ACTOR_ADMIN_ID);
      expect(auditData.entityId).toBe(TARGET_USER_ID);
    });
  });
});

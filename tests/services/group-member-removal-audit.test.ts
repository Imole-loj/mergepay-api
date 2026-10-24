import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(async ({ data }: any) => ({ ...data })),
    delete: vi.fn(async ({ where }: any) => ({ ...where })),
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
import { removeGroupMember, modifyGroupMemberRole } from "../../src/services/groups";
import { AuditAction } from "../../src/services/audit-actions";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const GROUP_ID = "group_audit_rm_test";
const ACTOR_ADMIN_ID = "user_admin_actor_rm";
const TARGET_USER_ID = "user_target_member_rm";
const SECOND_ADMIN_ID = "user_admin_second_rm";
const PUBLIC_KEY = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function authHeader(userId = ACTOR_ADMIN_ID) {
  return {
    authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: PUBLIC_KEY })}`,
  };
}

describe("Group Member Removal and Role Updates Audit Logging (#868)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    if (!app) app = await buildApp();

    prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID, name: "Alpha Force" });
    prisma.auditLog.create.mockResolvedValue({ id: "audit_log_rm_123" });
  });

  describe("removeGroupMember service function", () => {
    it("successfully removes a standard member and persists structured audit log", async () => {
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

      prisma.groupMember.delete.mockResolvedValue({
        id: "mem_target",
        groupId: GROUP_ID,
        userId: TARGET_USER_ID,
        role: "member",
      });

      const result = await removeGroupMember({
        actorUserId: ACTOR_ADMIN_ID,
        groupId: GROUP_ID,
        targetUserId: TARGET_USER_ID,
      });

      expect(result.userId).toBe(TARGET_USER_ID);
      expect(result.groupId).toBe(GROUP_ID);
      expect(result.removedRole).toBe("member");

      expect(prisma.groupMember.delete).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);

      const auditData = prisma.auditLog.create.mock.calls[0][0].data;
      expect(auditData).toMatchObject({
        userId: ACTOR_ADMIN_ID,
        groupId: GROUP_ID,
        action: AuditAction.GROUP_MEMBER_REMOVE,
        entityType: "group_member",
        entityId: TARGET_USER_ID,
        metadata: {
          targetUserId: TARGET_USER_ID,
          removedRole: "member",
        },
      });
    });

    it("successfully removes an admin when multiple admins exist and records admin role", async () => {
      prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
        const userId = where.groupId_userId.userId;
        if (userId === ACTOR_ADMIN_ID) {
          return { id: "mem_actor", groupId: GROUP_ID, userId: ACTOR_ADMIN_ID, role: "admin", joinedAt: new Date() };
        }
        if (userId === SECOND_ADMIN_ID) {
          return { id: "mem_second", groupId: GROUP_ID, userId: SECOND_ADMIN_ID, role: "admin", joinedAt: new Date() };
        }
        return null;
      });

      prisma.groupMember.count.mockResolvedValue(2);
      prisma.groupMember.delete.mockResolvedValue({
        id: "mem_second",
        groupId: GROUP_ID,
        userId: SECOND_ADMIN_ID,
        role: "admin",
      });

      const result = await removeGroupMember({
        actorUserId: ACTOR_ADMIN_ID,
        groupId: GROUP_ID,
        targetUserId: SECOND_ADMIN_ID,
      });

      expect(result.removedRole).toBe("admin");
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);

      const auditData = prisma.auditLog.create.mock.calls[0][0].data;
      expect(auditData.action).toBe(AuditAction.GROUP_MEMBER_REMOVE);
      expect(auditData.metadata.removedRole).toBe("admin");
    });

    it("rejects removing the last remaining admin and creates no audit log", async () => {
      prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
        const userId = where.groupId_userId.userId;
        if (userId === ACTOR_ADMIN_ID) {
          return { id: "mem_actor", groupId: GROUP_ID, userId: ACTOR_ADMIN_ID, role: "admin", joinedAt: new Date() };
        }
        if (userId === SECOND_ADMIN_ID) {
          return { id: "mem_second", groupId: GROUP_ID, userId: SECOND_ADMIN_ID, role: "admin", joinedAt: new Date() };
        }
        return null;
      });

      // Only 1 admin in group
      prisma.groupMember.count.mockResolvedValue(1);

      await expect(
        removeGroupMember({
          actorUserId: ACTOR_ADMIN_ID,
          groupId: GROUP_ID,
          targetUserId: SECOND_ADMIN_ID,
        })
      ).rejects.toThrow("Cannot remove the last admin from the group");

      expect(prisma.groupMember.delete).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("rejects self-removal and redirects to leave endpoint", async () => {
      await expect(
        removeGroupMember({
          actorUserId: ACTOR_ADMIN_ID,
          groupId: GROUP_ID,
          targetUserId: ACTOR_ADMIN_ID,
        })
      ).rejects.toThrow("Cannot remove yourself from the group; use the leave endpoint instead");

      expect(prisma.groupMember.delete).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("throws 404 when target member does not exist in group", async () => {
      prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
        const userId = where.groupId_userId.userId;
        if (userId === ACTOR_ADMIN_ID) {
          return { id: "mem_actor", groupId: GROUP_ID, userId: ACTOR_ADMIN_ID, role: "admin", joinedAt: new Date() };
        }
        return null;
      });

      await expect(
        removeGroupMember({
          actorUserId: ACTOR_ADMIN_ID,
          groupId: GROUP_ID,
          targetUserId: "non_existent_user",
        })
      ).rejects.toThrow("Member not found in this group");

      expect(prisma.groupMember.delete).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe("API Route Integration: DELETE /groups/:id/members/:memberId", () => {
    it("successfully delegates to removeGroupMember and writes audit log", async () => {
      prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
        const userId = where?.groupId_userId?.userId;
        if (userId === ACTOR_ADMIN_ID) {
          return { id: "mem_actor", groupId: GROUP_ID, userId: ACTOR_ADMIN_ID, role: "admin", joinedAt: new Date() };
        }
        if (userId === TARGET_USER_ID) {
          return { id: "mem_target", groupId: GROUP_ID, userId: TARGET_USER_ID, role: "member", joinedAt: new Date() };
        }
        return null;
      });

      prisma.groupMember.findFirst.mockImplementation(async ({ where }: any) => {
        const userId = where?.userId;
        if (userId === ACTOR_ADMIN_ID) {
          return { id: "mem_actor", groupId: GROUP_ID, userId: ACTOR_ADMIN_ID, role: "admin", joinedAt: new Date() };
        }
        return null;
      });

      prisma.groupMember.delete.mockResolvedValue({
        id: "mem_target",
        groupId: GROUP_ID,
        userId: TARGET_USER_ID,
        role: "member",
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/groups/${GROUP_ID}/members/${TARGET_USER_ID}`,
        headers: authHeader(ACTOR_ADMIN_ID),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);

      const auditData = prisma.auditLog.create.mock.calls[0][0].data;
      expect(auditData.action).toBe(AuditAction.GROUP_MEMBER_REMOVE);
      expect(auditData.userId).toBe(ACTOR_ADMIN_ID);
      expect(auditData.entityId).toBe(TARGET_USER_ID);
      expect(auditData.metadata).toMatchObject({
        targetUserId: TARGET_USER_ID,
        removedRole: "member",
      });
    });
  });
});

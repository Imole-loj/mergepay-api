import { describe, it, expect, vi, beforeEach } from "vitest";

import { assertGroupAdmin } from "../../src/services/groups";
import { Errors } from "../../src/errors";

const mockDb = vi.hoisted(() => ({
  members: new Map<string, { role: string }>(),
  groups: new Map<string, { archived: boolean }>(),
  auditLogs: [] as any[],
}));

vi.mock("../../src/db", () => ({
  prisma: {
    groupMember: {
      findUnique: vi.fn(async ({ where }: { where: { groupId_userId: { groupId: string; userId: string } } }) => {
        const key = `${where.groupId_userId.groupId}:${where.groupId_userId.userId}`;
        const found = mockDb.members.get(key);
        return found ? { ...found } : null;
      }),
    },
    group: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const found = mockDb.groups.get(where.id);
        return found ? { id: where.id, ...found } : null;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        mockDb.auditLogs.push(data);
        return { id: "log-1", ...data };
      }),
    },
  },
}));

describe("Group Treasury Role Checks (assertGroupAdmin) (#908)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.members.clear();
    mockDb.groups.clear();
    mockDb.auditLogs.length = 0;
  });

  it("authorizes a user with admin role in an active group", async () => {
    mockDb.groups.set("group-1", { archived: false });
    mockDb.members.set("group-1:user-admin", { role: "admin" });

    const ctx = await assertGroupAdmin("user-admin", "group-1");
    expect(ctx.userId).toBe("user-admin");
    expect(ctx.groupId).toBe("group-1");
    expect(ctx.role).toBe("admin");
  });

  it("authorizes an admin with active: true in an active group", async () => {
    mockDb.groups.set("group-1", { archived: false });
    mockDb.members.set("group-1:user-admin", { role: "admin" });

    const ctx = await assertGroupAdmin("user-admin", "group-1", { active: true });
    expect(ctx.role).toBe("admin");
  });

  it("rejects a member who holds only 'member' role with 403 Forbidden", async () => {
    mockDb.groups.set("group-1", { archived: false });
    mockDb.members.set("group-1:user-regular", { role: "member" });

    await expect(assertGroupAdmin("user-regular", "group-1")).rejects.toThrow(
      /Only a group admin can perform this action/
    );
  });

  it("rejects a user who is not a member of the group with 403 Forbidden", async () => {
    mockDb.groups.set("group-1", { archived: false });

    await expect(assertGroupAdmin("non-member", "group-1")).rejects.toThrow(
      /You are not a member of this group/
    );
  });

  it("rejects when the group does not exist with 404 Not Found", async () => {
    await expect(assertGroupAdmin("any-user", "non-existent-group")).rejects.toThrow(
      /Group not found/
    );
  });

  it("rejects an admin in an archived group when active: true is specified", async () => {
    mockDb.groups.set("group-archived", { archived: true });
    mockDb.members.set("group-archived:user-admin", { role: "admin" });

    await expect(
      assertGroupAdmin("user-admin", "group-archived", { active: true })
    ).rejects.toThrow(/Group is archived/);
  });

  it("records an audit log on unauthorized access attempts", async () => {
    mockDb.groups.set("group-1", { archived: false });
    mockDb.members.set("group-1:user-regular", { role: "member" });

    try {
      await assertGroupAdmin("user-regular", "group-1");
    } catch {
      // Expected rejection
    }

    // Wait microtask for void audit()
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDb.auditLogs.length).toBeGreaterThanOrEqual(1);
    const log = mockDb.auditLogs[0];
    expect(log.userId).toBe("user-regular");
    expect(log.groupId).toBe("group-1");
    expect(log.action).toBe("treasury.signer_validation");
  });
});

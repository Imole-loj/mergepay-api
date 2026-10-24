import { describe, it, expect, beforeEach, vi, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
  });
  const prisma: any = {
    group: model(),
    groupMember: model(),
    expense: model(),
  };
  const members = new Map<string, { role: string; archived: boolean }>();
  return { prisma, members };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import {
  requireGroupMember,
  requireGroupAdmin,
  groupMembership,
  groupMember,
} from "../../src/middleware/group-guard";
import { Errors } from "../../src/errors";
import errorHandlerPlugin from "../../src/plugins/error-handler";

describe("Group Membership & Role Verification Middleware (#887)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(errorHandlerPlugin);

    // Dummy auth decorator
    app.decorate("authenticate", async (req: any) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer user_")) {
        throw Errors.unauthorized("Authentication required");
      }
      const userId = authHeader.replace("Bearer ", "");
      req.user = { id: userId, stellarPublicKey: `G${userId.toUpperCase()}` };
    });

    // Mock prisma queries based on h.members map
    h.prisma.group.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === "grp_missing") return null;
      const archived = where.id === "grp_archived";
      return { id: where.id, archived, name: "Test Group" };
    });

    h.prisma.groupMember.findUnique.mockImplementation(
      async ({ where }: any) => {
        const { groupId_userId } = where;
        const key = `${groupId_userId.groupId}:${groupId_userId.userId}`;
        const entry = h.members.get(key);
        if (!entry) return null;
        return {
          id: `gm_${key}`,
          groupId: groupId_userId.groupId,
          userId: groupId_userId.userId,
          role: entry.role,
          group: {
            id: groupId_userId.groupId,
            isArchived: entry.archived,
          },
        };
      }
    );

    // Route requiring membership
    app.get(
      "/groups/:id/member-only",
      {
        preHandler: [app.authenticate as any, requireGroupMember()],
      },
      async (req) => {
        const mem = groupMember(req);
        return { ok: true, membership: mem };
      }
    );

    // Route requiring active membership (disallow archived)
    app.post(
      "/groups/:id/active-member-only",
      {
        preHandler: [app.authenticate as any, requireGroupMember({ active: true })],
      },
      async (req) => {
        const mem = groupMembership(req);
        return { ok: true, membership: mem };
      }
    );

    // Route requiring admin role
    app.post(
      "/groups/:id/admin-only",
      {
        preHandler: [app.authenticate as any, requireGroupAdmin()],
      },
      async (req) => {
        const mem = groupMember(req);
        return { ok: true, membership: mem };
      }
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    h.members.clear();
    // Alice is admin in grp_1
    h.members.set("grp_1:user_alice", { role: "admin", archived: false });
    // Bob is member in grp_1
    h.members.set("grp_1:user_bob", { role: "member", archived: false });
    // Charlie is in archived group grp_archived
    h.members.set("grp_archived:user_charlie", { role: "member", archived: true });
  });

  it("allows active member and attaches member context to request", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/grp_1/member-only",
      headers: { authorization: "Bearer user_bob" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.membership).toMatchObject({
      groupId: "grp_1",
      userId: "user_bob",
      role: "member",
    });
  });

  it("allows admin on member-only route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/grp_1/member-only",
      headers: { authorization: "Bearer user_alice" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().membership.role).toBe("admin");
  });

  it("rejects non-member with 403 Forbidden", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/grp_1/member-only",
      headers: { authorization: "Bearer user_outsider" },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it("allows admin on admin-only route and attaches admin context", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups/grp_1/admin-only",
      headers: { authorization: "Bearer user_alice" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().membership.role).toBe("admin");
  });

  it("rejects regular member with 403 Forbidden on admin-only route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups/grp_1/admin-only",
      headers: { authorization: "Bearer user_bob" },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it("rejects archived group with 403 when active: true is enforced", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups/grp_archived/active-member-only",
      headers: { authorization: "Bearer user_charlie" },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.message).toMatch(/archived/i);
  });

  it("rejects unauthenticated caller with 401 Unauthorized", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/grp_1/member-only",
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects non-existent group with 404 Not Found", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/grp_missing/member-only",
      headers: { authorization: "Bearer user_alice" },
    });

    expect(res.statusCode).toBe(404);
  });
});

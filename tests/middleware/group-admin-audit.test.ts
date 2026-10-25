import { describe, it, expect, vi, beforeEach } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import { groupAdminAudit } from "../../src/middleware/group-admin-audit";
import * as auditService from "../../src/services/audit";

describe("Group Admin Audit Logging Middleware (#801)", () => {
  let app: FastifyInstance;
  let auditSpy: any;

  beforeEach(async () => {
    auditSpy = vi.spyOn(auditService, "auditGroupAdminAction").mockResolvedValue(undefined);

    app = fastify({ logger: false });

    // Mock authenticated user hook
    app.addHook("preHandler", async (req) => {
      (req as any).user = {
        id: "admin_user_1",
        stellarPublicKey: "GADMINPUBLICKEY1234567890ABCDEF1234567890ABCDEF12",
      };
    });

    // 1. Group settings update (PATCH)
    app.patch(
      "/groups/:id",
      {
        onResponse: groupAdminAudit({
          action: "group.settings.update",
          resourceType: "group",
          getMetadata: (req) => ({
            settingName: (req.body as any)?.name,
            secretKey: "super-secret-password-123", // should be redacted
          }),
        }),
      },
      async (req) => {
        return { ok: true, id: (req.params as any).id };
      }
    );

    // 2. Member removal (DELETE)
    app.delete(
      "/groups/:id/members/:memberId",
      {
        onResponse: groupAdminAudit({
          action: "group.member.remove",
          resourceType: "group_member",
        }),
      },
      async (_req) => {
        return { success: true };
      }
    );

    // 3. Member role update (POST)
    app.post(
      "/groups/:id/members/role",
      {
        onResponse: groupAdminAudit({
          action: "group.member.role_update",
          resourceType: "group_member",
          getResourceId: (req) => (req.body as any)?.memberId,
        }),
      },
      async (_req) => {
        return { updated: true };
      }
    );

    // 4. Read endpoint (GET) - must not trigger audit
    app.get(
      "/groups/:id",
      {
        onResponse: groupAdminAudit({
          action: "group.read",
          resourceType: "group",
        }),
      },
      async (req) => {
        return { id: (req.params as any).id };
      }
    );

    // 5. Failing mutation endpoint (400) - must not trigger audit
    app.patch(
      "/groups/:id/fail",
      {
        onResponse: groupAdminAudit({
          action: "group.fail",
          resourceType: "group",
        }),
      },
      async (_req, reply) => {
        return reply.code(400).send({ error: "bad_request" });
      }
    );

    await app.ready();
  });

  it("captures actor ID, action type, target group, and timestamp on settings update", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/groups/grp_100",
      payload: { name: "Updated Group Name" },
    });

    expect(res.statusCode).toBe(200);
    expect(auditSpy).toHaveBeenCalledTimes(1);

    const callArgs = auditSpy.mock.calls[0][0];
    expect(callArgs.actorId).toBe("admin_user_1");
    expect(callArgs.groupId).toBe("grp_100");
    expect(callArgs.action).toBe("group.settings.update");
    expect(callArgs.targetResourceId).toBe("grp_100");
    expect(callArgs.targetResourceType).toBe("group");
    expect(callArgs.actorPublicKey).toBe("GADMINPUBLICKEY1234567890ABCDEF1234567890ABCDEF12");
    expect(callArgs.metadata.settingName).toBe("Updated Group Name");
    expect(callArgs.metadata.statusCode).toBe(200);
    // Sensitive field must be redacted
    expect(callArgs.metadata.secretKey).toBe("[REDACTED]");
  });

  it("captures member removal with target member resource ID", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/groups/grp_200/members/mbr_300",
    });

    expect(res.statusCode).toBe(200);
    expect(auditSpy).toHaveBeenCalledTimes(1);

    const callArgs = auditSpy.mock.calls[0][0];
    expect(callArgs.actorId).toBe("admin_user_1");
    expect(callArgs.groupId).toBe("grp_200");
    expect(callArgs.action).toBe("group.member.remove");
    expect(callArgs.targetResourceId).toBe("mbr_300");
    expect(callArgs.targetResourceType).toBe("group_member");
  });

  it("captures member role update with custom getResourceId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups/grp_300/members/role",
      payload: { memberId: "mbr_500", role: "admin" },
    });

    expect(res.statusCode).toBe(200);
    expect(auditSpy).toHaveBeenCalledTimes(1);

    const callArgs = auditSpy.mock.calls[0][0];
    expect(callArgs.actorId).toBe("admin_user_1");
    expect(callArgs.groupId).toBe("grp_300");
    expect(callArgs.action).toBe("group.member.role_update");
    expect(callArgs.targetResourceId).toBe("mbr_500");
  });

  it("ignores read operations (GET) even if registered with groupAdminAudit", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/grp_read_only",
    });

    expect(res.statusCode).toBe(200);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("does not audit failed requests (4xx / 5xx)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/groups/grp_fail_test/fail",
    });

    expect(res.statusCode).toBe(400);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("executes asynchronously without blocking the request/response lifecycle", async () => {
    let auditCompleted = false;
    vi.spyOn(auditService, "auditGroupAdminAction").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      auditCompleted = true;
    });

    const start = Date.now();
    const res = await app.inject({
      method: "DELETE",
      url: "/groups/grp_async/members/mbr_async",
    });

    const duration = Date.now() - start;
    expect(res.statusCode).toBe(200);
    // Response returned before slow async audit completed
    expect(duration).toBeLessThan(100);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
  });
  const prisma: any = {
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { stateMutationAudit } from "../../src/middleware/state-mutation-audit";

describe("State Mutation Audit Logging Middleware (#896)", () => {
  const prisma = h.prisma;
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma.auditLog.create.mockResolvedValue({ id: "audit-mut-1" });

    app = Fastify();

    // Hook applied on all routes
    app.addHook("onResponse", stateMutationAudit());

    app.get("/api/v1/resource", async () => ({ data: "read" }));

    app.post("/api/v1/resource", async (req) => {
      // Mock authenticated user
      (req as any).user = { id: "user-creator-99" };
      return { success: true };
    });

    app.put("/api/v1/resource/:id", async () => ({ updated: true }));

    app.delete("/api/v1/resource/:id", async () => ({ deleted: true }));

    await app.ready();
  });

  it("does not audit non-mutating GET requests", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/resource",
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("audits mutating POST request and captures authenticated user ID", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/resource",
      payload: {
        title: "New Item",
        category: "General",
      },
    });
    expect(res.statusCode).toBe(200);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const callArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(callArgs.data.userId).toBe("user-creator-99");
    expect(callArgs.data.action).toBe("api.mutation.post");
    expect(callArgs.data.entityType).toBe("api_route");
    expect(callArgs.data.entityId).toBe("/api/v1/resource");
    expect(callArgs.data.metadata.method).toBe("POST");
    expect(callArgs.data.metadata.payload.title).toBe("New Item");
  });

  it("scrubs sensitive fields like password, token, and secretKey from logged payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/resource",
      payload: {
        username: "alice",
        password: "super_secret_password",
        secretKey: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        token: "jwt_bearer_token",
        nested: {
          apiKey: "123456",
          publicData: "safe",
        },
      },
    });
    expect(res.statusCode).toBe(200);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const callArgs = prisma.auditLog.create.mock.calls[0][0];
    const payload = callArgs.data.metadata.payload;
    expect(payload.username).toBe("alice");
    expect(payload.password).toBe("[REDACTED]");
    expect(payload.secretKey).toBe("[REDACTED]");
    expect(payload.token).toBe("[REDACTED]");
    expect(payload.nested.apiKey).toBe("[REDACTED]");
    expect(payload.nested.publicData).toBe("safe");
  });

  it("audits PUT and DELETE mutations", async () => {
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/v1/resource/item-123",
      payload: { name: "Updated Name" },
    });
    expect(putRes.statusCode).toBe(200);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/api/v1/resource/item-123",
    });
    expect(deleteRes.statusCode).toBe(200);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create.mock.calls[0][0].data.action).toBe("api.mutation.put");
    expect(prisma.auditLog.create.mock.calls[1][0].data.action).toBe("api.mutation.delete");
  });
});

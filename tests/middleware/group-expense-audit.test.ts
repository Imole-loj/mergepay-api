import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    auditLog: model(),
    group: model(),
    expense: model(),
    settlement: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  auditGroupExpenseMutation,
  type GroupExpenseMutationAuditParams,
} from "../../src/services/audit";
import { groupExpenseAudit } from "../../src/middleware/group-expense-audit";

describe("Structured JSON Audit Logging for Group and Expense Operations (#903)", () => {
  const prisma = h.prisma;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.auditLog.create.mockResolvedValue({ id: "audit_test_id" });
  });

  describe("auditGroupExpenseMutation helper", () => {
    it("persists an audit row with actor, IP, and target entity metadata", async () => {
      const pubkey = Keypair.random().publicKey();
      await auditGroupExpenseMutation({
        userId: "user-123",
        actorPublicKey: pubkey,
        clientIp: "192.168.1.100",
        groupId: "group-456",
        action: "group.expense.create",
        entityType: "expense",
        entityId: "expense-789",
        metadata: { amount: 1500, currency: "USDC" },
      });

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const callArgs = prisma.auditLog.create.mock.calls[0][0];
      expect(callArgs.data.userId).toBe("user-123");
      expect(callArgs.data.groupId).toBe("group-456");
      expect(callArgs.data.action).toBe("group.expense.create");
      expect(callArgs.data.entityType).toBe("expense");
      expect(callArgs.data.entityId).toBe("expense-789");
      expect(callArgs.data.metadata.clientIp).toBe("192.168.1.100");
      expect(callArgs.data.metadata.actorPublicKey).toBe(pubkey);
      expect(callArgs.data.metadata.actorType).toBe("user");
      expect(callArgs.data.metadata.outcome).toBe("success");
    });

    it("handles system actor when userId is not provided", async () => {
      await auditGroupExpenseMutation({
        groupId: "group-system",
        action: "group.settlement.reconciled",
        entityType: "settlement",
        entityId: "settle-111",
        outcome: "success",
      });

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const callArgs = prisma.auditLog.create.mock.calls[0][0];
      expect(callArgs.data.userId).toBeNull();
      expect(callArgs.data.metadata.actorType).toBe("system");
    });

    it("records failure outcome with error details", async () => {
      await auditGroupExpenseMutation({
        userId: "user-failed",
        groupId: "group-fail",
        action: "group.expense.update",
        entityType: "expense",
        entityId: "exp-000",
        outcome: "failure",
        metadata: { error: "Validation rejected invalid split ratio" },
      });

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const callArgs = prisma.auditLog.create.mock.calls[0][0];
      expect(callArgs.data.metadata.outcome).toBe("failure");
      expect(callArgs.data.metadata.error).toBe("Validation rejected invalid split ratio");
    });
  });

  describe("groupExpenseAudit middleware hook", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = Fastify();

      app.get(
        "/groups/:groupId/expenses",
        {
          onResponse: groupExpenseAudit({
            action: "group.expense.list",
            entityType: "expense",
          }),
        },
        async () => ({ expenses: [] })
      );

      app.post(
        "/groups/:groupId/expenses",
        {
          onResponse: groupExpenseAudit({
            action: "group.expense.create",
            entityType: "expense",
            getEntityId: () => "exp-created-1",
          }),
        },
        async () => ({ id: "exp-created-1", status: "created" })
      );

      app.put(
        "/groups/:groupId/expenses/:expenseId",
        {
          onResponse: groupExpenseAudit({
            action: "group.expense.update",
            entityType: "expense",
          }),
        },
        async () => ({ updated: true })
      );

      app.delete(
        "/groups/:groupId/expenses/:expenseId",
        {
          onResponse: groupExpenseAudit({
            action: "group.expense.delete",
            entityType: "expense",
          }),
        },
        async () => ({ deleted: true })
      );

      app.post(
        "/groups/:groupId/settlements",
        {
          onResponse: groupExpenseAudit({
            action: "group.settle",
            entityType: "settlement",
            getEntityId: () => "settle-99",
          }),
        },
        async () => ({ settlementId: "settle-99" })
      );

      app.post(
        "/groups/:groupId/fail",
        {
          onResponse: groupExpenseAudit({
            action: "group.fail.op",
            entityType: "group",
          }),
        },
        async (_req, reply) => {
          return reply.status(400).send({ error: "bad request" });
        }
      );

      await app.ready();
    });

    it("ignores non-mutating GET requests", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/groups/grp-1/expenses",
      });
      expect(res.statusCode).toBe(200);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("ignores non-2xx responses", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/groups/grp-1/fail",
      });
      expect(res.statusCode).toBe(400);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("records mutating POST on group expense creation with route params and IP", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/groups/grp-100/expenses",
        headers: {
          "x-forwarded-for": "10.0.0.5",
          "x-stellar-public-key": "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA",
        },
      });
      expect(res.statusCode).toBe(200);

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const call = prisma.auditLog.create.mock.calls[0][0];
      expect(call.data.groupId).toBe("grp-100");
      expect(call.data.action).toBe("group.expense.create");
      expect(call.data.entityType).toBe("expense");
      expect(call.data.entityId).toBe("exp-created-1");
      expect(call.data.metadata.clientIp).toBe("10.0.0.5");
      expect(call.data.metadata.actorPublicKey).toBe("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA");
    });

    it("records mutating PUT and extracts expenseId from path params", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/groups/grp-200/expenses/exp-update-55",
      });
      expect(res.statusCode).toBe(200);

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const call = prisma.auditLog.create.mock.calls[0][0];
      expect(call.data.groupId).toBe("grp-200");
      expect(call.data.entityId).toBe("exp-update-55");
      expect(call.data.action).toBe("group.expense.update");
    });

    it("records mutating DELETE on group expense removal", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/groups/grp-300/expenses/exp-del-12",
      });
      expect(res.statusCode).toBe(200);

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const call = prisma.auditLog.create.mock.calls[0][0];
      expect(call.data.groupId).toBe("grp-300");
      expect(call.data.entityId).toBe("exp-del-12");
      expect(call.data.action).toBe("group.expense.delete");
    });

    it("records settlement creation on group settlements endpoint", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/groups/grp-400/settlements",
      });
      expect(res.statusCode).toBe(200);

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const call = prisma.auditLog.create.mock.calls[0][0];
      expect(call.data.groupId).toBe("grp-400");
      expect(call.data.entityType).toBe("settlement");
      expect(call.data.entityId).toBe("settle-99");
      expect(call.data.action).toBe("group.settle");
    });
  });
});

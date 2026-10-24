import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({ id: "row_1" })),
    createMany: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findUniqueOrThrow: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    statusHistory: model(),
    idempotencyKey: model(),
    accountBalance: model(),
    refreshToken: model(),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 1),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import {
  requireExpensePayerOrAdmin,
  requireExpenseMutationRole,
  requireExpenseModificationGuard,
} from "../../src/middleware/group-guard";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const GROUP_ID = "grp_guard_test";
const EXPENSE_ID = "exp_guard_test";
const PAYER_MEMBER_ID = "user_payer_member";
const OTHER_MEMBER_ID = "user_other_member";
const ADMIN_ID = "user_admin_guard";
const OUTSIDER_ID = "user_outsider_guard";
const PUBLIC_KEY = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function bearer(userId: string) {
  return `Bearer ${signToken({ id: userId, stellarPublicKey: PUBLIC_KEY })}`;
}

describe("Group Membership Role Check Middleware for Expense Modification Routes (#808)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    if (!app) app = await buildApp();

    prisma.group.findUnique.mockResolvedValue({
      id: GROUP_ID,
      name: "Expense Guard Test Group",
      archived: false,
      createdByUserId: ADMIN_ID,
    });

    prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
      const { groupId, userId } = where?.groupId_userId || {};
      if (groupId !== GROUP_ID) return null;
      if (userId === ADMIN_ID) return { groupId, userId, role: "admin" };
      if (userId === PAYER_MEMBER_ID) return { groupId, userId, role: "member" };
      if (userId === OTHER_MEMBER_ID) return { groupId, userId, role: "member" };
      return null;
    });

    prisma.expense.findUnique.mockResolvedValue({
      id: EXPENSE_ID,
      groupId: GROUP_ID,
      payerUserId: PAYER_MEMBER_ID,
      title: "Shared Conference Ticket",
      amount: "150.00",
      assetCode: "XLM",
      splitType: "equal",
      payer: { id: PAYER_MEMBER_ID, stellarPublicKey: PUBLIC_KEY, createdAt: new Date("2026-01-01T00:00:00.000Z") },
      shares: [
        { id: "share_1", userId: PAYER_MEMBER_ID, shareAmount: "75.00", status: "settled" },
        { id: "share_2", userId: OTHER_MEMBER_ID, shareAmount: "75.00", status: "pending" },
      ],
    });

    prisma.expense.update.mockResolvedValue({
      id: EXPENSE_ID,
      groupId: GROUP_ID,
      payerUserId: PAYER_MEMBER_ID,
      title: "Updated Ticket",
      description: null,
      amount: "150.00",
      assetCode: "XLM",
      assetIssuer: null,
      splitType: "equal",
      memo: null,
      receiptUrl: null,
      payer: { id: PAYER_MEMBER_ID, stellarPublicKey: PUBLIC_KEY, createdAt: new Date("2026-01-01T00:00:00.000Z") },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      shares: [],
    });

    prisma.expense.delete.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({ id: "audit_guard_1" });
  });

  describe("Middleware aliases export check", () => {
    it("exports requireExpensePayerOrAdmin, requireExpenseMutationRole, requireExpenseModificationGuard", () => {
      expect(typeof requireExpensePayerOrAdmin).toBe("function");
      expect(requireExpenseMutationRole).toBe(requireExpensePayerOrAdmin);
      expect(requireExpenseModificationGuard).toBe(requireExpensePayerOrAdmin);
    });
  });

  describe("PATCH /expenses/:id — Role check middleware", () => {
    it("rejects non-members with 403 Forbidden", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/expenses/${EXPENSE_ID}`,
        headers: { authorization: bearer(OUTSIDER_ID) },
        payload: { title: "Hacked Title" },
      });

      expect(res.statusCode).toBe(403);
      expect(prisma.expense.update).not.toHaveBeenCalled();
    });

    it("rejects a member who is neither the payer nor an admin with 403 Forbidden", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/expenses/${EXPENSE_ID}`,
        headers: { authorization: bearer(OTHER_MEMBER_ID) },
        payload: { title: "Unauthorized Edit" },
      });

      expect(res.statusCode).toBe(403);
      expect(prisma.expense.update).not.toHaveBeenCalled();
    });

    it("allows the expense creator/payer to update expense metadata", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/expenses/${EXPENSE_ID}`,
        headers: { authorization: bearer(PAYER_MEMBER_ID) },
        payload: { title: "Updated Ticket" },
      });

      expect(res.statusCode).toBe(200);
      expect(prisma.expense.update).toHaveBeenCalledTimes(1);
    });

    it("allows a group admin to update any expense metadata", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/expenses/${EXPENSE_ID}`,
        headers: { authorization: bearer(ADMIN_ID) },
        payload: { title: "Admin Edited Title" },
      });

      expect(res.statusCode).toBe(200);
      expect(prisma.expense.update).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when the expense does not exist", async () => {
      prisma.expense.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: "PATCH",
        url: `/expenses/non_existent_exp`,
        headers: { authorization: bearer(ADMIN_ID) },
        payload: { title: "New Title" },
      });

      expect(res.statusCode).toBe(404);
      expect(prisma.expense.update).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /expenses/:id — Role check middleware", () => {
    it("rejects non-members with 403 Forbidden", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/expenses/${EXPENSE_ID}`,
        headers: { authorization: bearer(OUTSIDER_ID) },
      });

      expect(res.statusCode).toBe(403);
      expect(prisma.expense.delete).not.toHaveBeenCalled();
    });

    it("rejects a member who is neither the payer nor an admin with 403 Forbidden", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/expenses/${EXPENSE_ID}`,
        headers: { authorization: bearer(OTHER_MEMBER_ID) },
      });

      expect(res.statusCode).toBe(403);
      expect(prisma.expense.delete).not.toHaveBeenCalled();
    });

    it("allows the expense payer to delete an unsettled expense", async () => {
      // Mock shares with no settled non-payer shares
      prisma.expense.findUnique.mockResolvedValue({
        id: EXPENSE_ID,
        groupId: GROUP_ID,
        payerUserId: PAYER_MEMBER_ID,
        shares: [{ userId: OTHER_MEMBER_ID, status: "pending" }],
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/expenses/${EXPENSE_ID}`,
        headers: { authorization: bearer(PAYER_MEMBER_ID) },
      });

      expect(res.statusCode).toBe(200);
      expect(prisma.expense.delete).toHaveBeenCalledTimes(1);
    });

    it("allows a group admin to delete an unsettled expense", async () => {
      prisma.expense.findUnique.mockResolvedValue({
        id: EXPENSE_ID,
        groupId: GROUP_ID,
        payerUserId: PAYER_MEMBER_ID,
        shares: [{ userId: OTHER_MEMBER_ID, status: "pending" }],
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/expenses/${EXPENSE_ID}`,
        headers: { authorization: bearer(ADMIN_ID) },
      });

      expect(res.statusCode).toBe(200);
      expect(prisma.expense.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /expenses/:id/settle — Membership role check middleware", () => {
    it("rejects non-members with 403 Forbidden before reaching handler", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/expenses/${EXPENSE_ID}/settle`,
        headers: { authorization: bearer(OUTSIDER_ID) },
        payload: {},
      });

      expect(res.statusCode).toBe(403);
    });
  });
});

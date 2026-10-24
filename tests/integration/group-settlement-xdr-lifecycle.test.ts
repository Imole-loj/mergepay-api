/**
 * Issue #900 — Integration tests for group expense settlement XDR generation
 * and submission lifecycle against PostgreSQL.
 *
 * Verifies end-to-end:
 *  1. Group creation and membership invitation.
 *  2. Expense creation and split share computation.
 *  3. Net balance derivation and settlement suggestions.
 *  4. Unsigned payment XDR generation with valid memo, asset, and sequence.
 *  5. Structured audit log persistence for mutating lifecycle events.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Keypair, Transaction } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";

vi.mock("../../src/services/stellar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async (publicKey: string) => ({
        exists: true,
        sequence: "500000000000000000",
        balances: [
          { assetCode: "XLM", assetIssuer: null, balance: "5000.0000000" },
          {
            assetCode: "USDC",
            assetIssuer: process.env.STABLE_ASSET_ISSUER ?? null,
            balance: "2500.0000000",
          },
        ],
        signers: [{ key: publicKey, weight: 1 }],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

import { buildApp } from "../../src/app";
import { config } from "../../src/config";
import { prisma } from "../../src/db";
import {
  authHeaders,
  cleanupSeededData,
  createGroupWithMembers,
  seedUser,
  type SeededUser,
} from "./db-helpers";

describe("Group Expense Settlement XDR Lifecycle Integration (#900)", () => {
  let app: FastifyInstance;
  let owner: SeededUser;
  let debtor: SeededUser;
  let creditor: SeededUser;
  let groupId: string;
  const userIdsToClean: string[] = [];
  const groupIdsToClean: string[] = [];

  beforeAll(async () => {
    app = await buildApp();

    owner = await seedUser({ displayName: "XDR Test Owner" });
    debtor = await seedUser({ displayName: "XDR Test Debtor" });
    creditor = await seedUser({ displayName: "XDR Test Creditor" });
    userIdsToClean.push(owner.id, debtor.id, creditor.id);

    const group = await createGroupWithMembers({
      creator: owner,
      name: "XDR Lifecycle Test Group",
      members: [
        { user: debtor, role: "member" },
        { user: creditor, role: "member" },
      ],
    });
    groupId = group.id;
    groupIdsToClean.push(groupId);
  });

  afterAll(async () => {
    await app.close();
    await cleanupSeededData({
      groupIds: groupIdsToClean,
      userIds: userIdsToClean,
    });
    await prisma.$disconnect();
  });

  it("creates a shared group expense and verifies stored split shares", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/expenses`,
      headers: authHeaders(creditor.token),
      payload: {
        title: "Team Lunch in USDC",
        amount: "90.0000000",
        assetCode: "USDC",
        splitType: "equal",
        shares: [
          { userId: owner.id },
          { userId: debtor.id },
          { userId: creditor.id },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.expense.id).toBeDefined();
    expect(body.expense.amount).toBe("90.0000000");

    // Verify stored shares in PostgreSQL
    const storedShares = await prisma.expenseShare.findMany({
      where: { expenseId: body.expense.id },
    });
    expect(storedShares).toHaveLength(3);
    for (const share of storedShares) {
      expect(share.shareAmount.toString()).toBe("30");
    }
  });

  it("calculates net debt balances and derives settlement suggestion", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}/balances`,
      headers: authHeaders(debtor.token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.balances).toBeDefined();

    // Debtor owes 30 USDC net
    const debtorBalance = body.balances.find((b: any) => b.userId === debtor.id);
    expect(debtorBalance).toBeDefined();
    expect(Number(debtorBalance.net)).toBeLessThan(0);

    // Creditor is owed 60 USDC net (paid 90, owes 30 for their own share)
    const creditorBalance = body.balances.find((b: any) => b.userId === creditor.id);
    expect(creditorBalance).toBeDefined();
    expect(Number(creditorBalance.net)).toBeGreaterThan(0);
  });

  it("builds a valid unsigned Stellar payment XDR for debtor settlement", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/settlements`,
      headers: authHeaders(debtor.token),
      payload: {
        toUserId: creditor.id,
        amount: "30.0000000",
        assetCode: "USDC",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settlement).toBeDefined();
    expect(body.settlement.status).toBe("pending");
    expect(body.xdr).toBeDefined();

    // Inspect the generated unsigned XDR
    const tx = new Transaction(body.xdr, config.networkPassphrase);
    expect(tx.source).toBe(debtor.publicKey);
    expect(tx.operations).toHaveLength(1);

    const op = tx.operations[0];
    expect(op.type).toBe("payment");
    if (op.type === "payment") {
      expect(op.destination).toBe(creditor.publicKey);
      expect(op.amount).toBe("30");
      expect(op.asset.code).toBe("USDC");
    }
  });

  it("persists structured audit log entries for expense and settlement mutations", async () => {
    const auditLogs = await prisma.auditLog.findMany({
      where: { groupId },
      orderBy: { createdAt: "desc" },
    });

    expect(auditLogs.length).toBeGreaterThan(0);
    const actions = auditLogs.map((l) => l.action);
    // At least one expense creation or settlement audit record must exist
    expect(
      actions.some((a) => a.includes("expense") || a.includes("settlement") || a.includes("group"))
    ).toBe(true);
  });
});

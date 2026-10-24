import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db";
import { Keypair } from "@stellar/stellar-sdk";

describe("PostgreSQL Integration - Transactional Consistency and Rollback (#889)", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  });

  it("rolls back all operations when an error occurs inside a multi-operation transaction", async () => {
    const keypair1 = Keypair.random();
    const keypair2 = Keypair.random();

    let txError: Error | null = null;

    try {
      await prisma.$transaction(async (tx) => {
        // Step 1: Create user 1
        await tx.user.create({
          data: {
            stellarPublicKey: keypair1.publicKey(),
            displayName: "Tx User 1",
          },
        });

        // Step 2: Create user 2
        await tx.user.create({
          data: {
            stellarPublicKey: keypair2.publicKey(),
            displayName: "Tx User 2",
          },
        });

        // Step 3: Trigger intentional error
        throw new Error("INTENTIONAL_TRANSACTION_FAILURE");
      });
    } catch (err) {
      txError = err as Error;
    }

    expect(txError).toBeDefined();
    expect(txError?.message).toBe("INTENTIONAL_TRANSACTION_FAILURE");

    // Verify neither user was committed to the database
    const user1 = await prisma.user.findUnique({
      where: { stellarPublicKey: keypair1.publicKey() },
    });
    const user2 = await prisma.user.findUnique({
      where: { stellarPublicKey: keypair2.publicKey() },
    });

    expect(user1).toBeNull();
    expect(user2).toBeNull();
  });

  it("commits all operations atomically when a transaction completes successfully", async () => {
    const keypair = Keypair.random();

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          stellarPublicKey: keypair.publicKey(),
          displayName: "Committed Tx User",
        },
      });

      const group = await tx.group.create({
        data: {
          name: "Tx Group",
          createdByUserId: user.id,
        },
      });

      return { user, group };
    });

    createdUserIds.push(created.user.id);

    expect(created.user.id).toBeDefined();
    expect(created.group.id).toBeDefined();

    // Verify persistence
    const foundUser = await prisma.user.findUnique({
      where: { id: created.user.id },
    });
    const foundGroup = await prisma.group.findUnique({
      where: { id: created.group.id },
    });

    expect(foundUser).not.toBeNull();
    expect(foundGroup).not.toBeNull();
    expect(foundGroup?.createdByUserId).toBe(created.user.id);

    // Clean up group
    await prisma.group.delete({ where: { id: created.group.id } });
  });
});

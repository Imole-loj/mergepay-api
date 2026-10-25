import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Database Index Migrations for Group Expense & Participant Relations (#873)", () => {
  const schemaPath = path.join(__dirname, "../../prisma/schema.prisma");
  const schemaContent = fs.readFileSync(schemaPath, "utf8");

  const migrationPath = path.join(
    __dirname,
    "../../prisma/migrations/20261024000000_add_group_expense_and_participant_indexes/migration.sql"
  );

  it("declares index on GroupMember for (groupId, role)", () => {
    expect(schemaContent).toContain("@@index([groupId, role])");
  });

  it("declares composite indexes on Expense for (groupId, payerUserId) and (groupId, assetCode)", () => {
    expect(schemaContent).toContain("@@index([groupId, payerUserId])");
    expect(schemaContent).toContain("@@index([groupId, assetCode])");
  });

  it("declares composite index on ExpenseShare for (userId, status)", () => {
    expect(schemaContent).toContain("@@index([userId, status])");
  });

  it("declares composite indexes on Settlement for (groupId, status) and (groupId, createdAt)", () => {
    expect(schemaContent).toContain("@@index([groupId, status])");
    expect(schemaContent).toContain("@@index([groupId, createdAt])");
  });

  it("provides valid migration SQL defining the required indexes", () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, "utf8");

    expect(sql).toContain('CREATE INDEX "group_members_group_id_role_idx" ON "group_members"("group_id", "role");');
    expect(sql).toContain('CREATE INDEX "expenses_group_id_payer_user_id_idx" ON "expenses"("group_id", "payer_user_id");');
    expect(sql).toContain('CREATE INDEX "expenses_group_id_asset_code_idx" ON "expenses"("group_id", "asset_code");');
    expect(sql).toContain('CREATE INDEX "expense_shares_user_id_status_idx" ON "expense_shares"("user_id", "status");');
    expect(sql).toContain('CREATE INDEX "settlements_group_id_status_idx" ON "settlements"("group_id", "status");');
    expect(sql).toContain('CREATE INDEX "settlements_group_id_created_at_idx" ON "settlements"("group_id", "created_at");');
  });
});

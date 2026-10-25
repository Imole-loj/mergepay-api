-- High-traffic performance indexes for group expenses, participants, and settlements (issue #873).
--
-- As groups accumulate expenses, members, and settlement records over time:
-- 1. Filtering expenses by payer or asset within a group benefits from composite indexes.
-- 2. Looking up pending/settled shares for a specific participant across groups avoids full table scans.
-- 3. Querying group members by role (e.g. admins) speeds up authorization checks.
-- 4. Filtering settlements by status or date within a group optimizes history and balance reconciliation.

-- CreateIndex
CREATE INDEX "group_members_group_id_role_idx" ON "group_members"("group_id", "role");

-- CreateIndex
CREATE INDEX "expenses_group_id_payer_user_id_idx" ON "expenses"("group_id", "payer_user_id");

-- CreateIndex
CREATE INDEX "expenses_group_id_asset_code_idx" ON "expenses"("group_id", "asset_code");

-- CreateIndex
CREATE INDEX "expense_shares_user_id_status_idx" ON "expense_shares"("user_id", "status");

-- CreateIndex
CREATE INDEX "settlements_group_id_status_idx" ON "settlements"("group_id", "status");

-- CreateIndex
CREATE INDEX "settlements_group_id_created_at_idx" ON "settlements"("group_id", "created_at");

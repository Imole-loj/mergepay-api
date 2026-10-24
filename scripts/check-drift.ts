/**
 * Prisma Schema Drift & Migration Health Checker (#913 / #878).
 *
 * Runs diagnostic checks to ensure:
 * 1. Prisma schema is syntactically and relationally valid (`prisma validate`).
 * 2. All pending migrations are applied and synced (`prisma migrate status`).
 * 3. The database schema has zero drift against `prisma/schema.prisma` (`prisma migrate diff`).
 *
 * Emits clear diagnostic feedback suitable for both local development and CI runners.
 */

import { execSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config();

export interface DriftCheckResult {
  validSchema: boolean;
  syncedMigrations: boolean;
  driftDetected: boolean;
  diagnostics: string[];
}

export function formatDriftDiagnostics(options: {
  schemaValid?: boolean;
  migrationsSynced?: boolean;
  driftDetected?: boolean;
  dbUrlPresent?: boolean;
} = {}): DriftCheckResult {
  const diagnostics: string[] = [];
  const validSchema = options.schemaValid ?? true;
  const syncedMigrations = options.migrationsSynced ?? true;
  const driftDetected = options.driftDetected ?? false;
  const dbUrlPresent = options.dbUrlPresent ?? false;

  if (validSchema) {
    diagnostics.push("✅ Prisma schema syntax and relations are valid");
  } else {
    diagnostics.push("❌ Prisma schema validation failed");
  }

  if (dbUrlPresent) {
    if (syncedMigrations) {
      diagnostics.push("✅ All database migrations are applied and up to date");
    } else {
      diagnostics.push("⚠️ Migration status check reported unapplied migrations");
    }

    if (!driftDetected) {
      diagnostics.push("✅ Zero schema drift detected between database and schema.prisma");
    } else {
      diagnostics.push("❌ Schema drift detected: database model differs from schema.prisma");
    }
  } else {
    diagnostics.push("ℹ️ DATABASE_URL not set; skipping on-chain database drift comparison");
  }

  return {
    validSchema,
    syncedMigrations,
    driftDetected,
    diagnostics,
  };
}

export function runDriftDiagnostics(options?: {
  databaseUrl?: string;
  execSyncFn?: (cmd: string, opts?: { env?: Record<string, string | undefined>; stdio?: string }) => string | Buffer;
}): DriftCheckResult {
  const runner = options?.execSyncFn ?? execSync;
  const dbUrl = options?.databaseUrl ?? process.env.DATABASE_URL;

  let schemaValid = false;
  try {
    runner("npx prisma validate", {
      env: { ...process.env, DATABASE_URL: dbUrl ?? "postgresql://localhost:5432/mergepay_mock" },
      stdio: "pipe",
    });
    schemaValid = true;
  } catch {
    schemaValid = false;
  }

  let migrationsSynced = false;
  let driftDetected = false;

  if (dbUrl) {
    try {
      runner("npx prisma migrate status", {
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: "pipe",
      });
      migrationsSynced = true;
    } catch {
      migrationsSynced = false;
    }

    try {
      runner('npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code', {
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: "pipe",
      });
      driftDetected = false;
    } catch {
      driftDetected = true;
    }
  }

  return formatDriftDiagnostics({
    schemaValid,
    migrationsSynced,
    driftDetected,
    dbUrlPresent: Boolean(dbUrl),
  });
}

if (typeof require !== "undefined" && require.main === module) {
  const result = runDriftDiagnostics();
  for (const line of result.diagnostics) {
    console.log(line);
  }
  if (!result.validSchema || result.driftDetected) {
    process.exit(1);
  }
}

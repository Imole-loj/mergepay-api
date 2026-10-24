import { describe, it, expect } from "vitest";

import { formatDriftDiagnostics } from "../../scripts/check-drift";

describe("Prisma Schema Drift Diagnostics (#913)", () => {
  it("formats positive diagnostic messages when all checks pass", () => {
    const result = formatDriftDiagnostics({
      schemaValid: true,
      migrationsSynced: true,
      driftDetected: false,
      dbUrlPresent: true,
    });
    expect(result.validSchema).toBe(true);
    expect(result.syncedMigrations).toBe(true);
    expect(result.driftDetected).toBe(false);
    expect(result.diagnostics).toContain("✅ Prisma schema syntax and relations are valid");
    expect(result.diagnostics).toContain("✅ All database migrations are applied and up to date");
    expect(result.diagnostics).toContain("✅ Zero schema drift detected between database and schema.prisma");
  });

  it("handles missing DATABASE_URL gracefully", () => {
    const result = formatDriftDiagnostics({
      schemaValid: true,
      dbUrlPresent: false,
    });
    expect(result.diagnostics).toContain("ℹ️ DATABASE_URL not set; skipping on-chain database drift comparison");
  });

  it("flags drift detection clearly", () => {
    const result = formatDriftDiagnostics({
      schemaValid: true,
      migrationsSynced: true,
      driftDetected: true,
      dbUrlPresent: true,
    });
    expect(result.driftDetected).toBe(true);
    expect(result.diagnostics.some((d) => d.includes("Schema drift detected"))).toBe(true);
  });
});

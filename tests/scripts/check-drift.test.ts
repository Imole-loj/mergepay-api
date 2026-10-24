import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  formatDriftDiagnostics,
  runDriftDiagnostics,
} from "../../scripts/check-drift";

describe("Prisma Schema Drift Diagnostics (#913 / #878)", () => {
  describe("formatDriftDiagnostics", () => {
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

  describe("runDriftDiagnostics execution runner", () => {
    it("executes validation and drift commands using provided executor", () => {
      const mockRunner = vi.fn((cmd: string) => {
        return "Command output";
      });

      const result = runDriftDiagnostics({
        databaseUrl: "postgresql://localhost:5432/test_db",
        execSyncFn: mockRunner as any,
      });

      expect(result.validSchema).toBe(true);
      expect(result.syncedMigrations).toBe(true);
      expect(result.driftDetected).toBe(false);
      expect(mockRunner).toHaveBeenCalledWith("npx prisma validate", expect.any(Object));
      expect(mockRunner).toHaveBeenCalledWith("npx prisma migrate status", expect.any(Object));
    });

    it("correctly identifies failing schema validation", () => {
      const mockRunner = vi.fn((cmd: string) => {
        if (cmd.includes("validate")) {
          throw new Error("Syntax error in schema.prisma");
        }
        return "OK";
      });

      const result = runDriftDiagnostics({
        databaseUrl: "postgresql://localhost:5432/test_db",
        execSyncFn: mockRunner as any,
      });

      expect(result.validSchema).toBe(false);
      expect(result.diagnostics).toContain("❌ Prisma schema validation failed");
    });

    it("correctly identifies migration drift when diff exits non-zero", () => {
      const mockRunner = vi.fn((cmd: string) => {
        if (cmd.includes("migrate diff")) {
          const err = new Error("Drift detected");
          (err as any).status = 2;
          throw err;
        }
        return "OK";
      });

      const result = runDriftDiagnostics({
        databaseUrl: "postgresql://localhost:5432/test_db",
        execSyncFn: mockRunner as any,
      });

      expect(result.driftDetected).toBe(true);
      expect(result.diagnostics.some((d) => d.includes("Schema drift detected"))).toBe(true);
    });
  });

  describe("CI Workflow Migration Drift Checks (.github/workflows/ci.yml)", () => {
    it("ensures CI configuration includes prisma schema validate and drift check steps", () => {
      const ciYamlPath = path.resolve(__dirname, "../../.github/workflows/ci.yml");
      expect(fs.existsSync(ciYamlPath)).toBe(true);

      const ciYaml = fs.readFileSync(ciYamlPath, "utf8");

      // Verify build-test job runs prisma validation
      expect(ciYaml).toContain("npm run prisma:validate");

      // Verify integration job checks migration status and drift
      expect(ciYaml).toContain("prisma:check-drift");
      expect(ciYaml).toContain("prisma:status");

      // Verify migration job applies and asserts zero drift
      expect(ciYaml).toContain("Assert schema and migrations do not drift");
    });
  });
});

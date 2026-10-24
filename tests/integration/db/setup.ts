import { execFileSync } from "node:child_process";
import { clearIntegrationDatabase } from "./truncate";
import { testDatabaseUrl } from "./dsn";

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

  try {
    execFileSync(npxCmd, ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    throw new Error(
      [
        `Integration suite could not prepare the test database (${redact(detail || String(error))}).`,
        "",
        "This suite runs against real Postgres. Start one and point the suite at it, e.g.",
        "  createdb mergepay_test                       # or any server you control",
        "  DATABASE_URL_TEST=postgresql://postgres@localhost:5432/mergepay_test npm run test:integration",
        "CI provisions the same database as a service container (see .github/workflows/ci.yml).",
      ].join("\n")
    );
  }

  const cleared = await clearIntegrationDatabase(url);
  // Emitted once per run, on purpose: the number of tables is the evidence that
  // the harness reached the schema the tests are about to assert against.
  console.log(
    `[integration] test database ready — ${cleared.length} tables provisioned and emptied`
  );
}

/** Keeps credentials out of failure output that ends up in CI logs. */
function redact(message: string): string {
  return message.replace(/postgresql:\/\/[^\s"']+/g, "postgresql://[redacted]");
}

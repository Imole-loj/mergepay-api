import { PrismaClient } from "@prisma/client";

/** Postgres identifiers are folded to lower case; quoting preserves them exactly. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function clearIntegrationDatabase(url: string): Promise<string[]> {
  const prisma = new PrismaClient({
    datasources: { db: { url } },
    log: ["error"],
  });

  try {
    const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename
         FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename <> '_prisma_migrations'
        ORDER BY tablename`
    );

    if (tables.length > 0) {
      const tableList = tables.map((t) => quoteIdent(t.tablename)).join(", ");
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`
      );
    }

    return tables.map((t) => t.tablename);
  } finally {
    await prisma.$disconnect();
  }
}

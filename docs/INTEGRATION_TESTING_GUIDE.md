# Integration Testing Guide with PostgreSQL

This guide explains how to run Mergepay's integration test suite locally and in CI against a real PostgreSQL database.

## Architecture

The integration test suite (`tests/integration/**/*.test.ts`) runs against a real PostgreSQL database rather than in-memory mocks to test:
- Database migrations and schema constraints
- Foreign key cascading behaviors
- Atomic transactions and rollbacks (`prisma.$transaction`)
- Complex multi-entity relations (Users, Groups, Expenses, Splits, Settlements)

## Prerequisites

Start a local PostgreSQL container using Docker:

```bash
docker run --name mergepay-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mergepay_test \
  -p 5432:5432 \
  -d postgres:16-alpine
```

Or use an existing PostgreSQL instance and create the test database:

```bash
createdb mergepay_test
```

## Running Integration Tests

Run the integration suite via npm:

```bash
DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/mergepay_test npm run test:integration
```

On Windows PowerShell:

```powershell
$env:DATABASE_URL_TEST="postgresql://postgres:postgres@localhost:5432/mergepay_test"
npm run test:integration
```

## Database Lifecycle in Tests

1. **Global Setup (`tests/integration/db/setup.ts`)**:
   - Executes `prisma db push --skip-generate --accept-data-loss` to provision the schema automatically.
   - Clears all tables using `clearIntegrationDatabase` before any test suite starts.
2. **Global Teardown (`tests/integration/db/teardown.ts`)**:
   - Disconnects database clients cleanly upon test completion.
3. **Table Truncation (`tests/integration/db/truncate.ts`)**:
   - Executes `TRUNCATE TABLE ... RESTART IDENTITY CASCADE` across all discovered application tables, guaranteeing clean test isolation without cross-test leakage.

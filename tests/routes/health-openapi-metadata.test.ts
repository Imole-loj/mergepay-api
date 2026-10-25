import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("../../src/db", () => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
  };
  return { prisma };
});

import { buildApp } from "../../src/app";

let spec: any;

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  spec = (app as any).swagger();
});

describe("OpenAPI metadata for health routes (#378)", () => {
  it("registers System tag in openapi spec", () => {
    const tagNames = spec.tags?.map((t: any) => t.name) || [];
    expect(tagNames).toContain("System");
  });

  it("documents /health with System tag, summary, description, and response schemas", () => {
    const op = spec.paths["/health"]?.get;
    expect(op).toBeDefined();
    expect(op.tags).toContain("System");
    expect(op.summary).toBe("Health readiness check");
    expect(op.description).toContain("readiness check");
    expect(op.responses).toBeDefined();
    expect(op.responses["200"]).toBeDefined();
    expect(op.responses["503"]).toBeDefined();
  });

  it("documents /health/live with System tag, summary, and description", () => {
    const op = spec.paths["/health/live"]?.get;
    expect(op).toBeDefined();
    expect(op.tags).toContain("System");
    expect(op.summary).toBe("Health liveness check");
    expect(op.description).toBeDefined();
    expect(op.responses["200"]).toBeDefined();
  });
});

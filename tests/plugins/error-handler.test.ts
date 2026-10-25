import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("../../src/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    group: { findUnique: vi.fn() },
    groupMember: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: false,
        sequence: "0",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

import { buildApp } from "../../src/app";
import { z } from "zod";
import { AppError, ErrorCode, Errors } from "../../src/lib/errors";
import { serializeError } from "../../src/plugins/error-handler";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();

  app.get("/test-zod/simple", async () => {
    z.object({ name: z.string().min(1) }).parse({ name: "" });
  });

  app.get("/test-zod/nested", async () => {
    z.object({
      user: z.object({
        age: z.number().min(18),
      }),
    }).parse({ user: { age: 15 } });
  });

  app.get("/test-errors/unhandled", async () => {
    throw new Error("sensitive database error or secret password leaked");
  });

  app.get("/test-errors/nullish", async () => {
    throw null;
  });

  app.get("/test-errors/bad-request", async () => {
    throw Errors.badRequest(
      ErrorCode.BAD_REQUEST,
      "Invalid query parameter provided",
      [{ field: "filter", message: "Unsupported filter" }]
    );
  });
});

describe("Fastify standardized error handling (#376)", () => {
  describe("Zod validation error handler", () => {
    it("returns 400 with structured details for simple Zod validation failure", async () => {
      const res = await app.inject({ method: "GET", url: "/test-zod/simple" });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(body.error.details)).toBe(true);
      expect(body.error.details[0]).toMatchObject({
        field: expect.any(String),
        message: expect.any(String),
        code: expect.any(String),
      });
      expect(body.requestId).toBeTruthy();
    });

    it("returns field-level details for nested Zod schemas", async () => {
      const res = await app.inject({ method: "GET", url: "/test-zod/nested" });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(body.error.details)).toBe(true);
      expect(body.error.details[0].field).toBe("user.age");
      expect(body.error.details[0].message).toContain("18");
      expect(body.requestId).toBeTruthy();
    });

    it("returns 400 for malformed POST body to a route with Zod validation", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/challenge",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Unhandled exceptions and internal safety", () => {
    it("returns 500 status code with safe generic message and does not leak internals", async () => {
      const res = await app.inject({ method: "GET", url: "/test-errors/unhandled" });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(body.error.message).toBe("Something went wrong.");
      expect(body.message).toBe("Something went wrong.");
      expect(JSON.stringify(body)).not.toContain("sensitive database error");
      expect(JSON.stringify(body)).not.toContain("secret password leaked");
      expect(body.requestId).toBeTruthy();
    });

    it("handles nullish thrown errors gracefully without crashing or leaking V8 details", async () => {
      const res = await app.inject({ method: "GET", url: "/test-errors/nullish" });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(body.error.message).toBe("Something went wrong.");
      expect(body.requestId).toBeTruthy();
    });
  });

  describe("AppError and Bad Request serialization", () => {
    it("serializes AppError with status code, message, and details", async () => {
      const res = await app.inject({ method: "GET", url: "/test-errors/bad-request" });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe(ErrorCode.BAD_REQUEST);
      expect(body.error.message).toBe("Invalid query parameter provided");
      expect(body.error.details).toEqual([
        { field: "filter", message: "Unsupported filter" },
      ]);
    });

    it("does not affect 404 responses for unknown routes", async () => {
      const res = await app.inject({ method: "GET", url: "/nonexistent-route-xyz" });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.code).toBe("NOT_FOUND");
      expect(body.statusCode).toBeUndefined();
    });
  });

  describe("serializeError helper function", () => {
    it("serializes nullish error into standard internal error", () => {
      const serialized = serializeError(null, "req-123");
      expect(serialized.error.code).toBe("INTERNAL_ERROR");
      expect(serialized.error.message).toBe("Something went wrong.");
      expect(serialized.error.requestId).toBe("req-123");
    });

    it("serializes ZodError into VALIDATION_ERROR with structured details", () => {
      let zodError: ZodError | null = null;
      try {
        z.object({ email: z.string().email() }).parse({ email: "invalid-email" });
      } catch (err) {
        zodError = err as ZodError;
      }
      expect(zodError).not.toBeNull();
      const serialized = serializeError(zodError!, "req-456");
      expect(serialized.error.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(serialized.error.details)).toBe(true);
      expect(serialized.error.requestId).toBe("req-456");
    });

    it("serializes AppError into its specific error code and details", () => {
      const appErr = new AppError(400, "BAD_REQUEST", "Bad parameter", [{ param: "id" }]);
      const serialized = serializeError(appErr, "req-789");
      expect(serialized.error.code).toBe("BAD_REQUEST");
      expect(serialized.error.message).toBe("Bad parameter");
      expect(serialized.error.details).toEqual([{ param: "id" }]);
    });
  });
});

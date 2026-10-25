import { describe, it, expect, vi, beforeEach } from "vitest";
import fastify, { FastifyInstance, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import authPlugin, { signToken } from "../../src/plugins/auth";
import errorHandlerPlugin from "../../src/plugins/error-handler";
import { config } from "../../src/config";

describe("SEP-10 & JWT Authentication Token Verification Error Handling & Logging (#802)", () => {
  let app: FastifyInstance;
  let warnLogs: { msg: string; obj?: any }[] = [];

  beforeEach(async () => {
    warnLogs = [];
    app = fastify({
      logger: false,
    });

    // Capture structured warn logs emitted on req.log
    app.addHook("onRequest", async (req) => {
      const origWarn = req.log.warn.bind(req.log);
      req.log.warn = (obj: any, msg?: string) => {
        if (typeof obj === "string") {
          warnLogs.push({ msg: obj });
        } else {
          warnLogs.push({ msg: msg ?? "", obj });
        }
        return origWarn(obj, msg);
      };
    });

    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);

    // Protected route with standard JWT / SEP10 Authorization header authentication
    app.get("/api/v1/protected", { preHandler: [app.authenticate] }, async (req) => {
      return { ok: true, user: req.user };
    });

    // Dedicated SEP-10 challenge authentication hook route
    app.post("/api/v1/sep10-protected", { preHandler: [app.authenticateSep10] }, async (req) => {
      return { ok: true, account: req.sep10Account };
    });

    await app.ready();
  });

  it("handles and logs missing authorization header with MISSING_TOKEN (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/protected",
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("MISSING_TOKEN");

    const warnLog = warnLogs.find((l) => l.obj?.authFailure === "missing_token");
    expect(warnLog).toBeDefined();
    expect(warnLog?.msg).toContain("missing authorization header");
  });

  it("handles and logs malformed bearer authorization header with MALFORMED_TOKEN (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/protected",
      headers: {
        authorization: "InvalidScheme token123",
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("MALFORMED_TOKEN");

    const warnLog = warnLogs.find((l) => l.obj?.authFailure === "malformed_token");
    expect(warnLog).toBeDefined();
    expect(warnLog?.msg).toContain("malformed Bearer authorization header");
  });

  it("handles and logs expired session token with TOKEN_EXPIRED (401)", async () => {
    const keypair = Keypair.random();
    const expiredToken = jwt.sign(
      { sub: "user_test_expired", pk: keypair.publicKey() },
      config.JWT_SECRET,
      {
        algorithm: "HS256",
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        expiresIn: -60,
      }
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/protected",
      headers: {
        authorization: `Bearer ${expiredToken}`,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("TOKEN_EXPIRED");

    const warnLog = warnLogs.find((l) => l.obj?.authFailure === "token_expired");
    expect(warnLog).toBeDefined();
    expect(warnLog?.obj?.errorCode).toBe("TOKEN_EXPIRED");
    expect(warnLog?.msg).toContain("session token expired");
  });

  it("handles and logs invalid token signature with INVALID_TOKEN (401)", async () => {
    const keypair = Keypair.random();
    const forgedToken = jwt.sign(
      { sub: "user_forged", pk: keypair.publicKey() },
      "wrong-secret-key",
      {
        algorithm: "HS256",
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        expiresIn: 3600,
      }
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/protected",
      headers: {
        authorization: `Bearer ${forgedToken}`,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");

    const warnLog = warnLogs.find((l) => l.obj?.authFailure === "invalid_token");
    expect(warnLog).toBeDefined();
    expect(warnLog?.obj?.errorCode).toBe("INVALID_TOKEN");
  });

  it("handles and logs token with missing required claims (pk) with INVALID_TOKEN (401)", async () => {
    const missingClaimToken = jwt.sign(
      { sub: "user_missing_claim" },
      config.JWT_SECRET,
      {
        algorithm: "HS256",
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        expiresIn: 3600,
      }
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/protected",
      headers: {
        authorization: `Bearer ${missingClaimToken}`,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");

    const warnLog = warnLogs.find((l) => l.obj?.authFailure === "invalid_token");
    expect(warnLog).toBeDefined();
  });

  it("handles and logs empty SEP-10 transaction in Authorization header with MALFORMED_TOKEN (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/protected",
      headers: {
        authorization: "SEP10 ",
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("MALFORMED_TOKEN");

    const warnLog = warnLogs.find((l) => l.obj?.authFailure === "malformed_sep10_header");
    expect(warnLog).toBeDefined();
  });

  it("handles and logs invalid SEP-10 challenge in Authorization header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/protected",
      headers: {
        authorization: "SEP10 AAAA_invalid_challenge_xdr",
      },
    });

    expect(res.statusCode).toBe(401);
    const warnLog = warnLogs.find((l) => l.obj?.authFailure === "sep10_challenge_invalid");
    expect(warnLog).toBeDefined();
  });

  it("handles and logs missing challenge in authenticateSep10 with 400 missing_challenge", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sep10-protected",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_CHALLENGE");

    const warnLog = warnLogs.find((l) => l.obj?.authFailure === "missing_challenge");
    expect(warnLog).toBeDefined();
  });

  it("successfully authenticates valid session token without warning logs", async () => {
    const user = { id: "user_valid_test", stellarPublicKey: Keypair.random().publicKey() };
    const validToken = signToken(user);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/protected",
      headers: {
        authorization: `Bearer ${validToken}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().user.id).toBe(user.id);
    expect(warnLogs).toHaveLength(0);
  });
});

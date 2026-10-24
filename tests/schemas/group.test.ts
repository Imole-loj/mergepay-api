/**
 * Issue #897 — Zod request validation unit tests for group creation, update,
 * and member invitation endpoints.
 *
 * Verifies that:
 *  1. Group creation payloads require valid names and consistent currency codes.
 *  2. Unrecognized properties are strictly rejected (.strict()).
 *  3. Member invitations enforce valid Stellar public keys and bounded invite codes.
 *  4. Group update payloads require at least one mutated attribute.
 *  5. Role updates enforce closed enum constraints ('admin' | 'member').
 */
import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createGroupSchema,
  updateGroupSchema,
  directInviteSchema,
  legacyInviteSchema,
  joinGroupSchema,
  changeMemberRoleSchema,
} from "../../src/schemas/group";

describe("Group Creation and Member Invitation Zod Validation (#897)", () => {
  const validStellarKey = Keypair.random().publicKey();

  describe("createGroupSchema", () => {
    it("validates compliant group creation body", () => {
      const parsed = createGroupSchema.parse({
        name: "Apartment Roommates",
        description: "Shared living expenses",
        currency: "USDC",
        members: [
          { userId: "usr-1", role: "admin" },
          { publicKey: validStellarKey, role: "member" },
        ],
      });
      expect(parsed.name).toBe("Apartment Roommates");
      expect(parsed.currency).toBe("USDC");
    });

    it("rejects empty or whitespace-only group name", () => {
      expect(() =>
        createGroupSchema.parse({
          name: "   ",
        })
      ).toThrow();
    });

    it("rejects contradictory currency aliases", () => {
      expect(() =>
        createGroupSchema.parse({
          name: "Test Group",
          currency: "XLM",
          defaultCurrency: "USDC",
        })
      ).toThrow(/must agree/i);
    });

    it("rejects unknown properties in strict mode", () => {
      expect(() =>
        createGroupSchema.parse({
          name: "Strict Group",
          unknownProperty: "malicious_injection",
        })
      ).toThrow();
    });
  });

  describe("updateGroupSchema", () => {
    it("validates valid partial updates", () => {
      const parsed = updateGroupSchema.parse({
        name: "Renamed Group",
        description: "New description",
      });
      expect(parsed.name).toBe("Renamed Group");
    });

    it("rejects empty update object requiring at least one field", () => {
      expect(() => updateGroupSchema.parse({})).toThrow(/at least one of/i);
    });
  });

  describe("directInviteSchema", () => {
    it("accepts valid Stellar public key invitation", () => {
      const parsed = directInviteSchema.parse({
        publicKey: validStellarKey,
      });
      expect(parsed.publicKey).toBe(validStellarKey);
    });

    it("rejects malformed public key", () => {
      expect(() =>
        directInviteSchema.parse({
          publicKey: "NOT_A_VALID_STELLAR_KEY",
        })
      ).toThrow();
    });
  });

  describe("legacyInviteSchema", () => {
    it("accepts valid code generation limits", () => {
      const parsed = legacyInviteSchema.parse({
        maxUses: 10,
        expiresInHours: 72,
      });
      expect(parsed.maxUses).toBe(10);
      expect(parsed.expiresInHours).toBe(72);
    });

    it("rejects excessive maxUses", () => {
      expect(() =>
        legacyInviteSchema.parse({
          maxUses: 99999,
        })
      ).toThrow();
    });

    it("rejects negative or zero maxUses", () => {
      expect(() =>
        legacyInviteSchema.parse({
          maxUses: 0,
        })
      ).toThrow();
    });
  });

  describe("joinGroupSchema", () => {
    it("accepts valid alphanumeric invite code", () => {
      const parsed = joinGroupSchema.parse({
        code: "ABCD1234EFGH",
      });
      expect(parsed.code).toBe("ABCD1234EFGH");
    });

    it("rejects invite code with special characters", () => {
      expect(() =>
        joinGroupSchema.parse({
          code: "CODE-WITH-INVALID!",
        })
      ).toThrow();
    });
  });

  describe("changeMemberRoleSchema", () => {
    it("accepts valid admin and member roles", () => {
      const admin = changeMemberRoleSchema.parse({
        userId: "user-1",
        role: "admin",
      });
      expect(admin.role).toBe("admin");

      const member = changeMemberRoleSchema.parse({
        userId: "user-2",
        role: "member",
      });
      expect(member.role).toBe("member");
    });

    it("rejects unclosed roles like owner or moderator", () => {
      expect(() =>
        changeMemberRoleSchema.parse({
          userId: "user-3",
          role: "owner" as any,
        })
      ).toThrow();
    });
  });
});

/**
 * Unit tests for Stellar memo validation helper functions and schemas (Issue #377).
 *
 * Covers:
 *  - `parseMemo`, `isValidMemoCode`, `isValidCodeChar`, `validateExpenseMemo`, `parseExpenseCode` (src/lib/memo.ts)
 *  - `memoText` formatting & truncation (src/services/stellar.ts)
 *  - `mergepayMemoSchema` (src/lib/memo.ts)
 *  - `mpMemoSchema`, `stellarAccountIdSchema`, `stellarPublicKeySchema` (src/lib/stellar-validation.ts)
 *  - `validatePaymentMemo` (src/lib/memo.ts)
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

vi.mock("../../src/db", () => ({
  prisma: {
    expense: { findFirst: vi.fn() },
    expenseShare: { count: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

import {
  parseMemo,
  isValidMemoCode,
  isValidCodeChar,
  validateExpenseMemo,
  parseExpenseCode,
  mergepayMemoSchema,
  validatePaymentMemo,
  MP_PREFIX,
  MAX_MEMO_BYTES,
} from "../../src/lib/memo";
import { memoText } from "../../src/services/stellar";
import {
  mpMemoSchema,
  stellarAccountIdSchema,
  stellarPublicKeySchema,
} from "../../src/lib/stellar-validation";
import { ALPHABET } from "../../src/services/codes";

describe("Stellar memo validation helper functions (#377)", () => {
  // ─── 1. Valid Memo Strings ────────────────────────────────────────────────
  describe("Valid memo strings and codes", () => {
    it("accepts a canonical 6-character code", () => {
      const memo = "MP:ABC234";
      const result = parseMemo(memo);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe("ABC234");
        expect(result.memo).toBe(memo);
      }
      expect(validateExpenseMemo(memo)).toBe(true);
      expect(parseExpenseCode(memo)).toBe("ABC234");
    });

    it("accepts a minimal 1-character code (MP:A)", () => {
      const memo = "MP:A";
      const result = parseMemo(memo);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe("A");
      }
      expect(validateExpenseMemo(memo)).toBe(true);
      expect(parseExpenseCode(memo)).toBe("A");
    });

    it("accepts maximum allowed code length reaching exactly 28 bytes", () => {
      // MP: is 3 bytes, so 25 characters from ALPHABET = 28 bytes
      const code = ALPHABET.slice(0, 25);
      const memo = `MP:${code}`;
      expect(Buffer.byteLength(memo, "utf8")).toBe(MAX_MEMO_BYTES);

      const result = parseMemo(memo);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe(code);
      }
      expect(validateExpenseMemo(memo)).toBe(true);
    });

    it("accepts all characters in the approved ALPHABET", () => {
      for (const ch of ALPHABET) {
        expect(isValidCodeChar(ch)).toBe(true);
        expect(isValidMemoCode(ch)).toBe(true);
        const memo = `MP:${ch}`;
        expect(parseMemo(memo).ok).toBe(true);
      }
    });
  });

  // ─── 2. Invalid Memo Strings & Edge Cases ────────────────────────────────
  describe("Invalid memo strings & edge cases", () => {
    it("rejects empty string", () => {
      const result = parseMemo("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("empty");
      }
      expect(validateExpenseMemo("")).toBe(false);
      expect(parseExpenseCode("")).toBeNull();
    });

    it("rejects non-string inputs", () => {
      expect(parseMemo(null as any).ok).toBe(false);
      expect(parseMemo(undefined as any).ok).toBe(false);
      expect(parseMemo(12345 as any).ok).toBe(false);
      expect(parseMemo({} as any).ok).toBe(false);
      expect(validateExpenseMemo(null as any)).toBe(false);
      expect(parseExpenseCode(undefined as any)).toBeNull();
    });

    it("rejects missing MP: prefix", () => {
      const inputs = [
        "ABC123DEF",
        "PREFIX:ABC123DEF",
        "mp:ABC123DEF", // lowercase prefix
        "Mp:ABC123DEF",
        "mP:ABC123DEF",
        "MP-ABC123DEF",
        "MP_ABC123DEF",
      ];
      for (const input of inputs) {
        const result = parseMemo(input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.message).toContain("MP:");
        }
        expect(validateExpenseMemo(input)).toBe(false);
        expect(parseExpenseCode(input)).toBeNull();
      }
    });

    it("rejects empty code after MP: prefix", () => {
      const result = parseMemo("MP:");
      expect(result.ok).toBe(false);
      expect(validateExpenseMemo("MP:")).toBe(false);
      expect(parseExpenseCode("MP:")).toBeNull();
    });

    it("rejects ambiguous characters (I, O, 0, 1) excluded from ALPHABET", () => {
      const ambiguous = ["I", "O", "0", "1"];
      for (const ch of ambiguous) {
        expect(isValidCodeChar(ch)).toBe(false);
        expect(isValidMemoCode(`ABC${ch}DEF`)).toBe(false);
        const result = parseMemo(`MP:ABC${ch}DEF`);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.message).toContain("invalid characters");
        }
      }
    });

    it("rejects lowercase letters in code", () => {
      expect(isValidMemoCode("abcdef")).toBe(false);
      const result = parseMemo("MP:abcdef");
      expect(result.ok).toBe(false);
    });

    it("rejects special characters and punctuation", () => {
      const specials = ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "-", "_", "+", "=", "[", "]", "{", "}", ";", ":", ",", ".", "/", "<", ">", "?", "\\", "|", "`", "~"];
      for (const s of specials) {
        expect(isValidCodeChar(s)).toBe(false);
        expect(isValidMemoCode(`ABC${s}DEF`)).toBe(false);
        expect(parseMemo(`MP:ABC${s}DEF`).ok).toBe(false);
      }
    });

    it("rejects whitespace in codes and memos", () => {
      const whitespaceInputs = [
        " MP:ABCDEF",
        "MP:ABCDEF ",
        "MP: ABCDEF",
        "MP:ABC DEF",
        "MP:ABC\tDEF",
        "MP:ABC\nDEF",
      ];
      for (const input of whitespaceInputs) {
        expect(parseMemo(input).ok).toBe(false);
        expect(validateExpenseMemo(input)).toBe(false);
      }
    });

    it("rejects multibyte and Unicode characters", () => {
      const unicodeInputs = [
        "MP:ABC🔥DEF",
        "MP:ABCéDEF",
        "MP:ABC€DEF",
        "MP:ABC\u200BDEF", // zero-width space
      ];
      for (const input of unicodeInputs) {
        expect(parseMemo(input).ok).toBe(false);
        expect(validateExpenseMemo(input)).toBe(false);
      }
    });

    it("rejects memo exceeding 28 bytes", () => {
      // 26 characters code + 3 bytes "MP:" = 29 bytes
      const longCode = ALPHABET.slice(0, 26);
      const memo = `MP:${longCode}`;
      expect(Buffer.byteLength(memo, "utf8")).toBe(29);

      const result = parseMemo(memo);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("28 UTF-8 bytes");
      }
      expect(validateExpenseMemo(memo)).toBe(false);
    });
  });

  // ─── 3. memoText (src/services/stellar.ts) ────────────────────────────────
  describe("memoText helper (src/services/stellar.ts)", () => {
    it("prefixes code with MP:", () => {
      expect(memoText("ABC123")).toBe("MP:ABC123");
    });

    it("preserves short code exactly under 28 bytes", () => {
      const code = "SHORT";
      expect(memoText(code)).toBe("MP:SHORT");
    });

    it("truncates oversized code to exactly 28 bytes", () => {
      const longCode = "A".repeat(50);
      const formatted = memoText(longCode);
      expect(formatted).toHaveLength(28);
      expect(formatted.startsWith("MP:")).toBe(true);
      expect(formatted).toBe(`MP:${"A".repeat(25)}`);
    });

    it("handles empty code gracefully", () => {
      expect(memoText("")).toBe("MP:");
    });
  });

  // ─── 4. mergepayMemoSchema (Zod) ──────────────────────────────────────────
  describe("mergepayMemoSchema Zod validation", () => {
    it("successfully parses valid MP:<code> memos", () => {
      const valid = "MP:ABC234XYZ";
      const result = mergepayMemoSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("fails with custom issue on invalid memo", () => {
      const invalid = "INVALID_MEMO";
      const result = mergepayMemoSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("MP:");
      }
    });
  });

  // ─── 5. mpMemoSchema (src/lib/stellar-validation.ts) ───────────────────────
  describe("mpMemoSchema Zod validation", () => {
    it("accepts string with MP: prefix within 28 bytes", () => {
      expect(mpMemoSchema.safeParse("MP:SETTLE123").success).toBe(true);
    });

    it("rejects string without MP: prefix", () => {
      const result = mpMemoSchema.safeParse("SETTLE123");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("MP:");
      }
    });

    it("rejects string longer than 28 bytes", () => {
      const result = mpMemoSchema.safeParse(`MP:${"X".repeat(30)}`);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("28 UTF-8 bytes");
      }
    });
  });

  // ─── 6. stellarAccountIdSchema & stellarPublicKeySchema ────────────────────
  describe("Stellar Account ID / Public Key validation", () => {
    it("accepts valid G... ed25519 public keys", () => {
      const keypair = Keypair.random();
      const pubKey = keypair.publicKey();
      expect(stellarAccountIdSchema.safeParse(pubKey).success).toBe(true);
      expect(stellarPublicKeySchema.safeParse(pubKey).success).toBe(true);
    });

    it("rejects secret keys (S...)", () => {
      const secret = Keypair.random().secret();
      expect(stellarAccountIdSchema.safeParse(secret).success).toBe(false);
      expect(stellarPublicKeySchema.safeParse(secret).success).toBe(false);
    });

    it("rejects malformed public keys (length mismatch or invalid base32)", () => {
      expect(stellarAccountIdSchema.safeParse("G123").success).toBe(false);
      expect(stellarAccountIdSchema.safeParse("").success).toBe(false);
      expect(stellarAccountIdSchema.safeParse(12345 as any).success).toBe(false);
    });
  });

  // ─── 7. validatePaymentMemo (On-Chain Memo Verification) ───────────────────
  describe("validatePaymentMemo (on-chain payment validation)", () => {
    const expectedCode = "ABC234";

    it("succeeds when text memo matches expected code exactly", () => {
      const result = validatePaymentMemo(
        { memoType: "text", memo: "MP:ABC234" },
        expectedCode
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe("ABC234");
        expect(result.memo).toBe("MP:ABC234");
      }
    });

    it("reports missing_memo when memoType is none or missing", () => {
      const res1 = validatePaymentMemo({ memoType: "none" }, expectedCode);
      expect(res1.ok).toBe(false);
      if (!res1.ok) expect(res1.reason).toBe("missing_memo");

      const res2 = validatePaymentMemo({}, expectedCode);
      expect(res2.ok).toBe(false);
      if (!res2.ok) expect(res2.reason).toBe("missing_memo");
    });

    it("reports missing_memo when text memo is empty", () => {
      const res = validatePaymentMemo({ memoType: "text", memo: "" }, expectedCode);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("missing_memo");
    });

    it("reports unsupported_memo_type for id or return memo types", () => {
      const resId = validatePaymentMemo({ memoType: "id", memo: "12345" }, expectedCode);
      expect(resId.ok).toBe(false);
      if (!resId.ok) expect(resId.reason).toBe("unsupported_memo_type");

      const resReturn = validatePaymentMemo({ memoType: "return", memo: "xyz" }, expectedCode);
      expect(resReturn.ok).toBe(false);
      if (!resReturn.ok) expect(resReturn.reason).toBe("unsupported_memo_type");
    });

    it("reports hash_memo_mismatch or invalid_hash_memo for hash memos", () => {
      // Malformed hash (not 32 bytes base64)
      const badHash = validatePaymentMemo({ memoType: "hash", memo: "badbase64" }, expectedCode);
      expect(badHash.ok).toBe(false);
      if (!badHash.ok) expect(badHash.reason).toBe("invalid_hash_memo");

      // Valid 32-byte hash
      const validHashBase64 = Buffer.alloc(32, 1).toString("base64");
      const goodHash = validatePaymentMemo(
        { memoType: "hash", memo: validHashBase64 },
        expectedCode
      );
      expect(goodHash.ok).toBe(false);
      if (!goodHash.ok) expect(goodHash.reason).toBe("hash_memo_mismatch");
    });

    it("reports malformed_memo when text memo has wrong prefix or invalid chars", () => {
      const res = validatePaymentMemo(
        { memoType: "text", memo: "INVALID_PREFIX" },
        expectedCode
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("malformed_memo");
    });

    it("reports code_mismatch when text memo has different code", () => {
      const res = validatePaymentMemo(
        { memoType: "text", memo: "MP:XYZ987" },
        expectedCode
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("code_mismatch");
    });
  });
});

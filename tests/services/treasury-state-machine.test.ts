import { describe, it, expect } from "vitest";
import {
  assertValidProposalTransition,
  assertCanAcceptSignatures,
  assertUniqueSignerSubmission,
  assertProposalExecutionThreshold,
  canTransitionProposalStatus,
  TERMINAL_PROPOSAL_STATUSES,
} from "../../src/services/treasury-validation";

describe("Treasury Multisig Proposal State Machine Validation (#902)", () => {
  describe("canTransitionProposalStatus", () => {
    it("allows valid linear lifecycle transitions", () => {
      expect(canTransitionProposalStatus("pending", "awaiting_signatures")).toBe(true);
      expect(canTransitionProposalStatus("pending", "ready")).toBe(true);
      expect(canTransitionProposalStatus("awaiting_signatures", "ready")).toBe(true);
      expect(canTransitionProposalStatus("ready", "submitted")).toBe(true);
      expect(canTransitionProposalStatus("submitted", "confirmed")).toBe(true);
    });

    it("allows transitions to failed or rejected from active states", () => {
      expect(canTransitionProposalStatus("pending", "failed")).toBe(true);
      expect(canTransitionProposalStatus("pending", "rejected")).toBe(true);
      expect(canTransitionProposalStatus("awaiting_signatures", "failed")).toBe(true);
      expect(canTransitionProposalStatus("awaiting_signatures", "rejected")).toBe(true);
      expect(canTransitionProposalStatus("ready", "failed")).toBe(true);
      expect(canTransitionProposalStatus("ready", "rejected")).toBe(true);
      expect(canTransitionProposalStatus("submitted", "failed")).toBe(true);
    });

    it("disallows backwards or invalid jumps", () => {
      expect(canTransitionProposalStatus("submitted", "pending")).toBe(false);
      expect(canTransitionProposalStatus("submitted", "awaiting_signatures")).toBe(false);
      expect(canTransitionProposalStatus("ready", "awaiting_signatures")).toBe(false);
      expect(canTransitionProposalStatus("confirmed", "submitted")).toBe(false);
      expect(canTransitionProposalStatus("failed", "ready")).toBe(false);
      expect(canTransitionProposalStatus("rejected", "ready")).toBe(false);
    });

    it("disallows any transitions from terminal states", () => {
      for (const terminal of TERMINAL_PROPOSAL_STATUSES) {
        expect(canTransitionProposalStatus(terminal, "pending")).toBe(false);
        expect(canTransitionProposalStatus(terminal, "submitted")).toBe(false);
        expect(canTransitionProposalStatus(terminal, "confirmed")).toBe(false);
        expect(canTransitionProposalStatus(terminal, "failed")).toBe(false);
      }
    });
  });

  describe("assertValidProposalTransition", () => {
    it("does not throw on valid transitions", () => {
      expect(() => assertValidProposalTransition("pending", "awaiting_signatures")).not.toThrow();
      expect(() => assertValidProposalTransition("awaiting_signatures", "ready")).not.toThrow();
      expect(() => assertValidProposalTransition("ready", "submitted")).not.toThrow();
      expect(() => assertValidProposalTransition("submitted", "confirmed")).not.toThrow();
    });

    it("throws 409 conflict when transitioning out of terminal states", () => {
      expect(() => assertValidProposalTransition("confirmed", "submitted")).toThrowError(
        /terminal state/i
      );
      expect(() => assertValidProposalTransition("failed", "ready")).toThrowError(
        /terminal state/i
      );
      expect(() => assertValidProposalTransition("rejected", "pending")).toThrowError(
        /terminal state/i
      );
    });

    it("throws 409 conflict on illegal transition paths", () => {
      expect(() => assertValidProposalTransition("submitted", "ready")).toThrowError(
        /invalid treasury proposal transition/i
      );
      expect(() => assertValidProposalTransition("ready", "pending")).toThrowError(
        /invalid treasury proposal transition/i
      );
    });
  });

  describe("assertCanAcceptSignatures", () => {
    it("allows active signature collection states", () => {
      expect(() => assertCanAcceptSignatures("pending")).not.toThrow();
      expect(() => assertCanAcceptSignatures("awaiting_signatures")).not.toThrow();
      expect(() => assertCanAcceptSignatures("ready")).not.toThrow();
    });

    it("rejects already submitted or confirmed proposals", () => {
      expect(() => assertCanAcceptSignatures("submitted")).toThrowError(
        /already been submitted or confirmed/i
      );
      expect(() => assertCanAcceptSignatures("confirmed")).toThrowError(
        /already been submitted or confirmed/i
      );
    });

    it("rejects failed or rejected proposals", () => {
      expect(() => assertCanAcceptSignatures("failed")).toThrowError(
        /failed or rejected state/i
      );
      expect(() => assertCanAcceptSignatures("rejected")).toThrowError(
        /failed or rejected state/i
      );
    });

    it("rejects unknown statuses", () => {
      expect(() => assertCanAcceptSignatures("ARCHIVED")).toThrowError(
        /cannot accept signatures/i
      );
    });
  });

  describe("assertUniqueSignerSubmission", () => {
    it("allows fresh signers", () => {
      const existing = ["GABC11111111111111111111111111111111111111111111111111111111"];
      const newKey = "GDEF22222222222222222222222222222222222222222222222222222222";
      expect(() => assertUniqueSignerSubmission(existing, newKey)).not.toThrow();
    });

    it("throws conflict when duplicate signer submits", () => {
      const existing = ["GABC11111111111111111111111111111111111111111111111111111111"];
      expect(() =>
        assertUniqueSignerSubmission(existing, "GABC11111111111111111111111111111111111111111111111111111111")
      ).toThrowError(/already submitted a signature/i);
    });
  });

  describe("assertProposalExecutionThreshold", () => {
    it("allows execution when weight meets or exceeds threshold", () => {
      expect(() => assertProposalExecutionThreshold(3, 3)).not.toThrow();
      expect(() => assertProposalExecutionThreshold(5, 3)).not.toThrow();
    });

    it("rejects execution when threshold is unmet", () => {
      expect(() => assertProposalExecutionThreshold(2, 3)).toThrowError(
        /does not meet the required threshold/i
      );
    });
  });
});

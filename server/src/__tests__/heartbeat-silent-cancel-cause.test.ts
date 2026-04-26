import { describe, expect, it } from "vitest";
import { deriveDequeueSilentCancelCause } from "../services/heartbeat.js";

describe("deriveDequeueSilentCancelCause (AIU-594)", () => {
  it("maps issue_comment_mentioned to mention-on-closed", () => {
    expect(deriveDequeueSilentCancelCause({ wakeReason: "issue_comment_mentioned" })).toBe(
      "mention-on-closed",
    );
  });

  it("maps issue_blockers_resolved to blocker-resolved-on-closed", () => {
    expect(deriveDequeueSilentCancelCause({ wakeReason: "issue_blockers_resolved" })).toBe(
      "blocker-resolved-on-closed",
    );
  });

  it("falls back to unknown for other issue-event wakeReasons", () => {
    for (const wakeReason of [
      "issue_assigned",
      "issue_commented",
      "issue_children_completed",
      "issue_reopened_via_comment",
      "execution_review_requested",
      "process_lost_retry",
      "missing_issue_comment",
    ]) {
      expect(deriveDequeueSilentCancelCause({ wakeReason })).toBe("unknown");
    }
  });

  it("falls back to unknown when wakeReason is missing or empty", () => {
    expect(deriveDequeueSilentCancelCause({})).toBe("unknown");
    expect(deriveDequeueSilentCancelCause({ wakeReason: "" })).toBe("unknown");
    expect(deriveDequeueSilentCancelCause({ wakeReason: "   " })).toBe("unknown");
    expect(deriveDequeueSilentCancelCause({ wakeReason: null })).toBe("unknown");
    expect(deriveDequeueSilentCancelCause({ wakeReason: 42 })).toBe("unknown");
  });
});

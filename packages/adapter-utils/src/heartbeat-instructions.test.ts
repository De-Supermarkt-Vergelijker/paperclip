import { describe, expect, it } from "vitest";
import { resolveHeartbeatInstructionsPath } from "./server-utils.js";

describe("resolveHeartbeatInstructionsPath", () => {
  it("loads broad file on heartbeat_timer when both mode-specific paths are set", () => {
    const result = resolveHeartbeatInstructionsPath(
      {
        instructionsFilePath: "/agents/legacy.md",
        heartbeatBroadFilePath: "/agents/HEARTBEAT-BROAD.md",
        heartbeatFocusedFilePath: "/agents/HEARTBEAT-FOCUSED.md",
      },
      { wakeReason: "heartbeat_timer" },
    );
    expect(result.instructionsFilePath).toBe("/agents/HEARTBEAT-BROAD.md");
    expect(result.mode).toBe("broad");
    expect(result.modeSpecific).toBe(true);
  });

  it("loads focused file on event-triggered wake reasons", () => {
    for (const wakeReason of [
      "issue_assigned",
      "issue_comment_mentioned",
      "issue_commented",
      "approval_approved",
      "manual",
    ]) {
      const result = resolveHeartbeatInstructionsPath(
        {
          heartbeatBroadFilePath: "/agents/HEARTBEAT-BROAD.md",
          heartbeatFocusedFilePath: "/agents/HEARTBEAT-FOCUSED.md",
        },
        { wakeReason },
      );
      expect(result.instructionsFilePath, `wakeReason=${wakeReason}`).toBe(
        "/agents/HEARTBEAT-FOCUSED.md",
      );
      expect(result.mode).toBe("focused");
      expect(result.modeSpecific).toBe(true);
    }
  });

  it("falls back to legacy instructionsFilePath when mode-specific field is missing", () => {
    // Broad timer but only focused configured — fall back to legacy.
    const broadFallback = resolveHeartbeatInstructionsPath(
      {
        instructionsFilePath: "/agents/AGENTS.md",
        heartbeatFocusedFilePath: "/agents/HEARTBEAT-FOCUSED.md",
      },
      { wakeReason: "heartbeat_timer" },
    );
    expect(broadFallback.instructionsFilePath).toBe("/agents/AGENTS.md");
    expect(broadFallback.mode).toBe("broad");
    expect(broadFallback.modeSpecific).toBe(false);

    // Focused wake but only broad configured — fall back to legacy.
    const focusedFallback = resolveHeartbeatInstructionsPath(
      {
        instructionsFilePath: "/agents/AGENTS.md",
        heartbeatBroadFilePath: "/agents/HEARTBEAT-BROAD.md",
      },
      { wakeReason: "issue_assigned" },
    );
    expect(focusedFallback.instructionsFilePath).toBe("/agents/AGENTS.md");
    expect(focusedFallback.mode).toBe("focused");
    expect(focusedFallback.modeSpecific).toBe(false);
  });

  it("preserves legacy behaviour when no mode-specific fields are configured", () => {
    const result = resolveHeartbeatInstructionsPath(
      { instructionsFilePath: "/agents/AGENTS.md" },
      { wakeReason: "heartbeat_timer" },
    );
    expect(result.instructionsFilePath).toBe("/agents/AGENTS.md");
    expect(result.modeSpecific).toBe(false);
  });

  it("defaults to focused mode when wakeReason is missing or empty", () => {
    for (const context of [{}, { wakeReason: "" }, { wakeReason: "   " }]) {
      const result = resolveHeartbeatInstructionsPath(
        {
          heartbeatBroadFilePath: "/agents/HEARTBEAT-BROAD.md",
          heartbeatFocusedFilePath: "/agents/HEARTBEAT-FOCUSED.md",
        },
        context,
      );
      expect(result.mode).toBe("focused");
      expect(result.instructionsFilePath).toBe("/agents/HEARTBEAT-FOCUSED.md");
    }
  });

  it("returns empty path when nothing is configured", () => {
    const result = resolveHeartbeatInstructionsPath({}, { wakeReason: "heartbeat_timer" });
    expect(result.instructionsFilePath).toBe("");
    expect(result.modeSpecific).toBe(false);
  });

  it("trims whitespace from configured paths", () => {
    const result = resolveHeartbeatInstructionsPath(
      { heartbeatBroadFilePath: "  /agents/HEARTBEAT-BROAD.md  " },
      { wakeReason: "heartbeat_timer" },
    );
    expect(result.instructionsFilePath).toBe("/agents/HEARTBEAT-BROAD.md");
    expect(result.modeSpecific).toBe(true);
  });
});

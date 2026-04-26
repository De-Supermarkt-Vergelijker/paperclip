import { describe, expect, it } from "vitest";
import type { IssueExecutionState } from "@paperclipai/shared";
import { activeStageParticipant, isActorActiveStageParticipant } from "./issue-execution-policy";

const boardUserId = "board-user";
const ctoUserId = "cto-user";
const ctoAgentId = "cto-agent";

function pendingApprovalState(participant: IssueExecutionState["currentParticipant"]): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "approval",
    currentParticipant: participant,
    returnAssignee: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
  };
}

describe("activeStageParticipant", () => {
  it("returns null when no execution state", () => {
    expect(activeStageParticipant({})).toBeNull();
    expect(activeStageParticipant({ executionState: null })).toBeNull();
  });

  it("returns null when execution state is not pending", () => {
    expect(
      activeStageParticipant({
        executionState: {
          ...pendingApprovalState({ type: "user", userId: boardUserId, agentId: null }),
          status: "completed",
        },
      }),
    ).toBeNull();
    expect(
      activeStageParticipant({
        executionState: {
          ...pendingApprovalState({ type: "user", userId: boardUserId, agentId: null }),
          status: "changes_requested",
        },
      }),
    ).toBeNull();
  });

  it("returns the current participant when stage is pending", () => {
    expect(
      activeStageParticipant({
        executionState: pendingApprovalState({ type: "user", userId: boardUserId, agentId: null }),
      }),
    ).toEqual({ type: "user", userId: boardUserId, agentId: null });
  });
});

describe("isActorActiveStageParticipant", () => {
  it("returns false when no active stage", () => {
    expect(isActorActiveStageParticipant({}, { userId: boardUserId })).toBe(false);
  });

  it("returns true when actor matches a user-typed active participant", () => {
    expect(
      isActorActiveStageParticipant(
        { executionState: pendingApprovalState({ type: "user", userId: boardUserId, agentId: null }) },
        { userId: boardUserId },
      ),
    ).toBe(true);
  });

  it("returns false when actor is a different user than the active user participant", () => {
    expect(
      isActorActiveStageParticipant(
        { executionState: pendingApprovalState({ type: "user", userId: boardUserId, agentId: null }) },
        { userId: ctoUserId },
      ),
    ).toBe(false);
  });

  it("returns true when actor's agentId matches an agent-typed active participant", () => {
    expect(
      isActorActiveStageParticipant(
        { executionState: pendingApprovalState({ type: "agent", userId: null, agentId: ctoAgentId }) },
        { agentId: ctoAgentId },
      ),
    ).toBe(true);
  });

  it("requires the matching identity field — user actor never matches an agent stage", () => {
    expect(
      isActorActiveStageParticipant(
        { executionState: pendingApprovalState({ type: "agent", userId: null, agentId: ctoAgentId }) },
        { userId: boardUserId },
      ),
    ).toBe(false);
  });
});

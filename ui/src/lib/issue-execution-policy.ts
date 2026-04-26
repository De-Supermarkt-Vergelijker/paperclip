import type {
  IssueExecutionPolicy,
  IssueExecutionStageParticipant,
  IssueExecutionStagePrincipal,
  IssueExecutionState,
} from "@paperclipai/shared";
import { parseAssigneeValue } from "./assignees";

interface ActiveStageActor {
  userId?: string | null;
  agentId?: string | null;
}

interface ActiveStageIssueLike {
  executionState?: IssueExecutionState | null;
}

/**
 * Returns the principal of the current participant when the issue's execution policy
 * has an active pending stage. Returns null when no stage is active (no policy, completed,
 * changes-requested, etc.) — in those cases reassignments are not gated by the stage.
 */
export function activeStageParticipant(
  issue: ActiveStageIssueLike | null | undefined,
): IssueExecutionStagePrincipal | null {
  const state = issue?.executionState;
  if (!state || state.status !== "pending") return null;
  return state.currentParticipant ?? null;
}

/**
 * Returns true when the actor (current user/agent) is the active reviewer/approver of
 * the issue's currently pending execution stage. While true, the backend rejects any
 * direct assignee-PATCH that targets a different principal — the actor must advance the
 * stage (approve / request-changes) or first remove themselves from the stage.
 */
export function isActorActiveStageParticipant(
  issue: ActiveStageIssueLike | null | undefined,
  actor: ActiveStageActor | null | undefined,
): boolean {
  const participant = activeStageParticipant(issue);
  if (!participant) return false;
  if (participant.type === "user") {
    return Boolean(actor?.userId && participant.userId === actor.userId);
  }
  return Boolean(actor?.agentId && participant.agentId === actor.agentId);
}

type StageType = "review" | "approval";

function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `stage-${Math.random().toString(36).slice(2)}`;
}

function principalKey(principal: IssueExecutionStagePrincipal | IssueExecutionStageParticipant) {
  return principal.type === "agent" ? `agent:${principal.agentId}` : `user:${principal.userId}`;
}

export function principalFromSelectionValue(value: string): IssueExecutionStagePrincipal | null {
  const selection = parseAssigneeValue(value);
  if (selection.assigneeAgentId) {
    return { type: "agent", agentId: selection.assigneeAgentId, userId: null };
  }
  if (selection.assigneeUserId) {
    return { type: "user", userId: selection.assigneeUserId, agentId: null };
  }
  return null;
}

export function selectionValueFromPrincipal(principal: IssueExecutionStagePrincipal | IssueExecutionStageParticipant): string {
  return principal.type === "agent" ? `agent:${principal.agentId}` : `user:${principal.userId}`;
}

export function stageParticipantValues(policy: IssueExecutionPolicy | null | undefined, stageType: StageType): string[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return stage?.participants.map((participant) => selectionValueFromPrincipal(participant)) ?? [];
}

function mergeParticipants(
  existing: IssueExecutionStageParticipant[] | undefined,
  values: string[],
): IssueExecutionStageParticipant[] {
  const existingByKey = new Map((existing ?? []).map((participant) => [principalKey(participant), participant]));
  const participants: IssueExecutionStageParticipant[] = [];
  for (const value of values) {
    const principal = principalFromSelectionValue(value);
    if (!principal) continue;
    const key = principalKey(principal);
    const previous = existingByKey.get(key);
    participants.push({
      id: previous?.id ?? newId(),
      type: principal.type,
      agentId: principal.type === "agent" ? principal.agentId ?? null : null,
      userId: principal.type === "user" ? principal.userId ?? null : null,
    });
  }
  return participants;
}

export function buildExecutionPolicy(input: {
  existingPolicy?: IssueExecutionPolicy | null;
  reviewerValues: string[];
  approverValues: string[];
}): IssueExecutionPolicy | null {
  const mode = input.existingPolicy?.mode ?? "normal";
  const stages: IssueExecutionPolicy["stages"] = [];

  const existingReviewStage = input.existingPolicy?.stages.find((stage) => stage.type === "review");
  const reviewParticipants = mergeParticipants(existingReviewStage?.participants, input.reviewerValues);
  if (reviewParticipants.length > 0) {
    stages.push({
      id: existingReviewStage?.id ?? newId(),
      type: "review" as const,
      approvalsNeeded: 1 as const,
      participants: reviewParticipants,
    });
  }

  const existingApprovalStage = input.existingPolicy?.stages.find((stage) => stage.type === "approval");
  const approvalParticipants = mergeParticipants(existingApprovalStage?.participants, input.approverValues);
  if (approvalParticipants.length > 0) {
    stages.push({
      id: existingApprovalStage?.id ?? newId(),
      type: "approval" as const,
      approvalsNeeded: 1 as const,
      participants: approvalParticipants,
    });
  }

  if (stages.length === 0) return null;

  return {
    mode,
    commentRequired: true,
    stages,
  };
}

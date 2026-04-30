import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { buildAutoAttachedApprovalPolicy } from "../services/issue-execution-policy.ts";

const AGENT_CREATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ASSIGNEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_CREATOR = "local-board";
const USER_ASSIGNEE = "other-user";

describe("buildAutoAttachedApprovalPolicy", () => {
  it("returns null when creator is missing", () => {
    expect(
      buildAutoAttachedApprovalPolicy({
        creator: {},
        assigneeAgentId: AGENT_ASSIGNEE,
      }),
    ).toBeNull();
  });

  it("returns null when assignee is missing", () => {
    expect(
      buildAutoAttachedApprovalPolicy({
        creator: { agentId: AGENT_CREATOR },
      }),
    ).toBeNull();
  });

  it("returns null when agent creator equals agent assignee", () => {
    expect(
      buildAutoAttachedApprovalPolicy({
        creator: { agentId: AGENT_CREATOR },
        assigneeAgentId: AGENT_CREATOR,
      }),
    ).toBeNull();
  });

  it("returns null when user creator equals user assignee", () => {
    expect(
      buildAutoAttachedApprovalPolicy({
        creator: { userId: USER_CREATOR },
        assigneeUserId: USER_CREATOR,
      }),
    ).toBeNull();
  });

  it("builds an approval-stage policy with agent creator as participant for agent→agent delegation", () => {
    const policy = buildAutoAttachedApprovalPolicy({
      creator: { agentId: AGENT_CREATOR },
      assigneeAgentId: AGENT_ASSIGNEE,
    });

    expect(policy).not.toBeNull();
    expect(policy?.mode).toBe("normal");
    expect(policy?.commentRequired).toBe(true);
    expect(policy?.stages).toHaveLength(1);
    const stage = policy!.stages[0]!;
    expect(stage.type).toBe("approval");
    expect(stage.approvalsNeeded).toBe(1);
    expect(stage.participants).toEqual([
      expect.objectContaining({ type: "agent", agentId: AGENT_CREATOR, userId: null }),
    ]);
  });

  it("builds an approval-stage policy with user creator as participant for user→agent delegation", () => {
    const policy = buildAutoAttachedApprovalPolicy({
      creator: { userId: USER_CREATOR },
      assigneeAgentId: AGENT_ASSIGNEE,
    });

    expect(policy?.stages[0]?.participants).toEqual([
      expect.objectContaining({ type: "user", userId: USER_CREATOR, agentId: null }),
    ]);
  });

  it("builds an approval-stage policy with agent creator as participant for agent→user delegation", () => {
    const policy = buildAutoAttachedApprovalPolicy({
      creator: { agentId: AGENT_CREATOR },
      assigneeUserId: USER_ASSIGNEE,
    });

    expect(policy?.stages[0]?.participants).toEqual([
      expect.objectContaining({ type: "agent", agentId: AGENT_CREATOR, userId: null }),
    ]);
  });

  it("prefers agentId over userId when both are present on the creator", () => {
    const policy = buildAutoAttachedApprovalPolicy({
      creator: { agentId: AGENT_CREATOR, userId: USER_CREATOR },
      assigneeAgentId: AGENT_ASSIGNEE,
    });

    expect(policy?.stages[0]?.participants[0]?.type).toBe("agent");
    expect(policy?.stages[0]?.participants[0]?.agentId).toBe(AGENT_CREATOR);
  });
});

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  findMentionedAgents: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    list: vi.fn(async () => []),
    resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
      agent: { id: reference },
      ambiguous: false,
    })),
  }),
  companyService: () => ({
    getById: vi.fn(async () => null),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  }),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    create: vi.fn(),
    acceptInteraction: vi.fn(),
    rejectInteraction: vi.fn(),
    answerQuestions: vi.fn(),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  }),
  issueReferenceService: () => ({
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
    diffIssueReferenceSummary: vi.fn(() => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    })),
    emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
    syncComment: vi.fn(async () => undefined),
    syncIssue: vi.fn(async () => undefined),
    syncDocument: vi.fn(async () => undefined),
    deleteDocumentSource: vi.fn(async () => undefined),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-auto-attach-1",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    identifier: "PAP-42",
    title: "Auto-attach test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

const AGENT_ACTOR = {
  type: "agent",
  agentId: AGENT_CREATOR,
  companyId: "company-1",
  companyIds: ["company-1"],
  source: "agent_key",
  runId: "run-1",
};

const BOARD_ACTOR = {
  type: "board",
  userId: USER_CREATOR,
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

describe("POST /api/companies/:companyId/issues — auto-attach approval policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.addComment.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.create.mockImplementation(async (_companyId: string, body: Record<string, unknown>) =>
      makeIssue({ ...body }),
    );
  });

  it("scenario 1: agent creator → different agent assignee auto-attaches creator-approval policy", async () => {
    const res = await request(createApp(AGENT_ACTOR))
      .post("/api/companies/company-1/issues")
      .send({ title: "Delegated", assigneeAgentId: AGENT_ASSIGNEE });

    expect(res.status).toBe(201);
    const payload = mockIssueService.create.mock.calls[0]?.[1] as Record<string, any>;
    expect(payload.executionPolicy).not.toBeNull();
    expect(payload.executionPolicy.stages).toHaveLength(1);
    expect(payload.executionPolicy.stages[0].type).toBe("approval");
    expect(payload.executionPolicy.stages[0].participants).toEqual([
      expect.objectContaining({ type: "agent", agentId: AGENT_CREATOR, userId: null }),
    ]);
  });

  it("scenario 2: agent creator self-assigning does not attach a policy", async () => {
    const res = await request(createApp(AGENT_ACTOR))
      .post("/api/companies/company-1/issues")
      .send({ title: "Self-delegated", assigneeAgentId: AGENT_CREATOR });

    expect(res.status).toBe(201);
    const payload = mockIssueService.create.mock.calls[0]?.[1] as Record<string, any>;
    expect(payload.executionPolicy).toBeNull();
  });

  it("scenario 3: board user creator → agent assignee auto-attaches board-approval policy", async () => {
    const res = await request(createApp(BOARD_ACTOR))
      .post("/api/companies/company-1/issues")
      .send({ title: "Board delegation", assigneeAgentId: AGENT_ASSIGNEE });

    expect(res.status).toBe(201);
    const payload = mockIssueService.create.mock.calls[0]?.[1] as Record<string, any>;
    expect(payload.executionPolicy.stages[0].participants).toEqual([
      expect.objectContaining({ type: "user", userId: USER_CREATOR, agentId: null }),
    ]);
  });

  it("scenario 4: agent creator → user assignee auto-attaches creator-approval policy", async () => {
    const res = await request(createApp(AGENT_ACTOR))
      .post("/api/companies/company-1/issues")
      .send({ title: "Agent-to-user delegation", assigneeUserId: USER_ASSIGNEE });

    expect(res.status).toBe(201);
    const payload = mockIssueService.create.mock.calls[0]?.[1] as Record<string, any>;
    expect(payload.executionPolicy.stages[0].participants).toEqual([
      expect.objectContaining({ type: "agent", agentId: AGENT_CREATOR, userId: null }),
    ]);
  });

  it("scenario 5: explicit executionPolicy: null opts out of auto-attach even when delegated", async () => {
    const res = await request(createApp(AGENT_ACTOR))
      .post("/api/companies/company-1/issues")
      .send({ title: "Opt-out", assigneeAgentId: AGENT_ASSIGNEE, executionPolicy: null });

    expect(res.status).toBe(201);
    const payload = mockIssueService.create.mock.calls[0]?.[1] as Record<string, any>;
    expect(payload.executionPolicy).toBeNull();
  });

  it("scenario 6: explicit executionPolicy in body overrides auto-attach", async () => {
    const customPolicy = {
      mode: "normal" as const,
      commentRequired: true,
      stages: [
        {
          type: "review" as const,
          participants: [
            { type: "agent" as const, agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
          ],
        },
      ],
    };

    const res = await request(createApp(AGENT_ACTOR))
      .post("/api/companies/company-1/issues")
      .send({
        title: "Custom policy override",
        assigneeAgentId: AGENT_ASSIGNEE,
        executionPolicy: customPolicy,
      });

    expect(res.status).toBe(201);
    const payload = mockIssueService.create.mock.calls[0]?.[1] as Record<string, any>;
    expect(payload.executionPolicy.stages).toHaveLength(1);
    expect(payload.executionPolicy.stages[0].type).toBe("review");
    expect(payload.executionPolicy.stages[0].participants[0].agentId).toBe(
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
  });

  it("scenario 7: no assignee (todo-like issue) does not attach a policy", async () => {
    const res = await request(createApp(AGENT_ACTOR))
      .post("/api/companies/company-1/issues")
      .send({ title: "Unassigned" });

    expect(res.status).toBe(201);
    const payload = mockIssueService.create.mock.calls[0]?.[1] as Record<string, any>;
    expect(payload.executionPolicy).toBeNull();
  });
});

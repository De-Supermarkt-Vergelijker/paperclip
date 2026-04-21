import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => ({ id: "wake-1" })));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getWakeableParentForChildEvent: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const baseChild = {
  id: "child-1",
  companyId: "company-1",
  identifier: "PAP-200",
  title: "Child task",
  description: null,
  priority: "medium",
  parentId: "parent-1",
  assigneeAgentId: "agent-child",
  assigneeUserId: null,
  createdByAgentId: null,
  createdByUserId: null,
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
};

describe("parent-event wakeup propagation on child status transitions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.resetAllMocks();
    mockWakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getWakeableParentForChildEvent.mockResolvedValue(null);
  });

  const transitions: Array<[string, string]> = [
    ["in_progress", "issue_child_in_progress"],
    ["in_review", "issue_child_in_review"],
    ["blocked", "issue_child_blocked"],
    ["done", "issue_child_done"],
    ["cancelled", "issue_child_cancelled"],
  ];

  for (const [targetStatus, expectedReason] of transitions) {
    it(`wakes parent assignee with ${expectedReason} when child transitions to ${targetStatus}`, async () => {
      const fromStatus = targetStatus === "in_progress" ? "assigned" : "in_progress";
      mockIssueService.getById.mockResolvedValue({ ...baseChild, status: fromStatus });
      mockIssueService.update.mockResolvedValue({ ...baseChild, status: targetStatus });
      mockIssueService.getWakeableParentForChildEvent.mockResolvedValue({
        id: "parent-1",
        identifier: "PAP-100",
        assigneeAgentId: "agent-parent",
        companyId: "company-1",
      });

      const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: targetStatus });
      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(mockWakeup).toHaveBeenCalledWith(
          "agent-parent",
          expect.objectContaining({
            reason: expectedReason,
            payload: expect.objectContaining({
              issueId: "parent-1",
              childIssueId: "child-1",
              childIdentifier: "PAP-200",
              childStatus: targetStatus,
              transitionFrom: fromStatus,
              transitionTo: targetStatus,
            }),
            contextSnapshot: expect.objectContaining({
              wakeReason: expectedReason,
              source: "issue.child_event",
              childIssueId: "child-1",
            }),
          }),
        );
      });
    });
  }

  it("does not fire child-event wake when parent assignee equals child assignee (dedup)", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseChild, status: "in_progress" });
    mockIssueService.update.mockResolvedValue({ ...baseChild, status: "done" });
    mockIssueService.getWakeableParentForChildEvent.mockResolvedValue({
      id: "parent-1",
      identifier: "PAP-100",
      assigneeAgentId: "agent-child",
      companyId: "company-1",
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockWakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_child_done" }),
    );
  });

  it("does not fire child-event wake when parent is not wakeable (terminal/unassigned)", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseChild, status: "in_progress" });
    mockIssueService.update.mockResolvedValue({ ...baseChild, status: "done" });
    mockIssueService.getWakeableParentForChildEvent.mockResolvedValue(null);

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockWakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_child_done" }),
    );
  });

  it("does not fire child-event wake when child has no parent", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseChild, parentId: null, status: "in_progress" });
    mockIssueService.update.mockResolvedValue({ ...baseChild, parentId: null, status: "done" });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockIssueService.getWakeableParentForChildEvent).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_child_done" }),
    );
  });

  it("does not fire child-event wake when status did not transition", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseChild, status: "in_progress" });
    mockIssueService.update.mockResolvedValue({ ...baseChild, status: "in_progress" });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ title: "new title" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockWakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_child_in_progress" }),
    );
  });

  it("wakes parent assignee with issue_child_created when a new child is created via parentId", async () => {
    const agentChildUuid = "00000000-0000-4000-8000-0000000000c1";
    const agentParentUuid = "00000000-0000-4000-8000-0000000000a1";
    const parentUuid = "00000000-0000-4000-8000-00000000aaaa";
    mockIssueService.create.mockResolvedValue({
      ...baseChild,
      assigneeAgentId: agentChildUuid,
      status: "backlog",
      parentId: parentUuid,
    });
    mockIssueService.getWakeableParentForChildEvent.mockResolvedValue({
      id: parentUuid,
      identifier: "PAP-100",
      assigneeAgentId: agentParentUuid,
      companyId: "company-1",
    });

    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "new child", parentId: parentUuid, assigneeAgentId: agentChildUuid });
    expect(res.status).toBe(201);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        agentParentUuid,
        expect.objectContaining({
          reason: "issue_child_created",
          payload: expect.objectContaining({
            issueId: parentUuid,
            childIssueId: "child-1",
            childIdentifier: "PAP-200",
            childAssigneeAgentId: agentChildUuid,
          }),
        }),
      );
    });
  });

  it("does not fire issue_child_created wake when parent assignee equals child assignee", async () => {
    const agentSameUuid = "00000000-0000-4000-8000-0000000000b1";
    const parentUuid = "00000000-0000-4000-8000-00000000bbbb";
    mockIssueService.create.mockResolvedValue({
      ...baseChild,
      assigneeAgentId: agentSameUuid,
      status: "backlog",
      parentId: parentUuid,
    });
    mockIssueService.getWakeableParentForChildEvent.mockResolvedValue({
      id: parentUuid,
      identifier: "PAP-100",
      assigneeAgentId: agentSameUuid,
      companyId: "company-1",
    });

    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "new child", parentId: parentUuid, assigneeAgentId: agentSameUuid });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockWakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_child_created" }),
    );
  });

  it("does not fire issue_child_created wake when parentId is not set", async () => {
    const agentChildUuid = "00000000-0000-4000-8000-0000000000c2";
    mockIssueService.create.mockResolvedValue({
      ...baseChild,
      assigneeAgentId: agentChildUuid,
      status: "backlog",
      parentId: null,
    });

    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "top-level issue", assigneeAgentId: agentChildUuid });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockIssueService.getWakeableParentForChildEvent).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_child_created" }),
    );
  });
});

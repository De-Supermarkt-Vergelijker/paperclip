import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => ({ id: "wake-1" })),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(async () => undefined),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getWakeableParentForChildEvent: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(async (_cid: string, payload: unknown) => payload),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

async function createApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/approvals.js")>("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const CHILD_UUID = "00000000-0000-4000-8000-000000000001";
const CHILD_UUID_2 = "00000000-0000-4000-8000-000000000002";

describe("approval create — parent-event wakeup propagation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(
      async (_cid: string, payload: unknown) => payload,
    );
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });
  });

  it("wakes parent assignee with issue_child_approval_pending when approval is linked to a child issue", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === CHILD_UUID) {
        return {
          id: CHILD_UUID,
          companyId: "company-1",
          identifier: "PAP-200",
          status: "in_progress",
          parentId: "parent-1",
          assigneeAgentId: "agent-child",
        };
      }
      return null;
    });
    mockIssueService.getWakeableParentForChildEvent.mockResolvedValue({
      id: "parent-1",
      identifier: "PAP-100",
      assigneeAgentId: "agent-parent",
      companyId: "company-1",
    });

    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {},
        issueIds: [CHILD_UUID],
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "agent-parent",
        expect.objectContaining({
          reason: "issue_child_approval_pending",
          payload: expect.objectContaining({
            issueId: "parent-1",
            childIssueId: CHILD_UUID,
            approvalId: "approval-1",
            approvalType: "request_board_approval",
          }),
          contextSnapshot: expect.objectContaining({
            wakeReason: "issue_child_approval_pending",
            source: "approval.created",
          }),
        }),
      );
    });
  });

  it("dedups wake when multiple linked children share the same parent assignee", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === CHILD_UUID) {
        return {
          id: CHILD_UUID,
          companyId: "company-1",
          identifier: "PAP-200",
          status: "in_progress",
          parentId: "parent-1",
          assigneeAgentId: "agent-child",
        };
      }
      if (id === CHILD_UUID_2) {
        return {
          id: CHILD_UUID_2,
          companyId: "company-1",
          identifier: "PAP-201",
          status: "in_progress",
          parentId: "parent-1",
          assigneeAgentId: "agent-child-2",
        };
      }
      return null;
    });
    mockIssueService.getWakeableParentForChildEvent.mockResolvedValue({
      id: "parent-1",
      identifier: "PAP-100",
      assigneeAgentId: "agent-parent",
      companyId: "company-1",
    });

    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {},
        issueIds: [CHILD_UUID, CHILD_UUID_2],
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() => {
      const childApprovalWakes = mockHeartbeatService.wakeup.mock.calls.filter(
        ([, req]) => (req as any)?.reason === "issue_child_approval_pending",
      );
      expect(childApprovalWakes).toHaveLength(1);
    });
  });

  it("does not wake when parent assignee equals child assignee", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: CHILD_UUID,
      companyId: "company-1",
      identifier: "PAP-200",
      status: "in_progress",
      parentId: "parent-1",
      assigneeAgentId: "agent-same",
    });
    mockIssueService.getWakeableParentForChildEvent.mockResolvedValue({
      id: "parent-1",
      identifier: "PAP-100",
      assigneeAgentId: "agent-same",
      companyId: "company-1",
    });

    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {},
        issueIds: [CHILD_UUID],
      });

    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_child_approval_pending" }),
    );
  });

  it("does not wake when linked issue has no parent", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: CHILD_UUID,
      companyId: "company-1",
      identifier: "PAP-200",
      status: "in_progress",
      parentId: null,
      assigneeAgentId: "agent-child",
    });

    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {},
        issueIds: [CHILD_UUID],
      });

    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockIssueService.getWakeableParentForChildEvent).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_child_approval_pending" }),
    );
  });

  it("does not wake when there are no linked issues", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {},
      });

    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});

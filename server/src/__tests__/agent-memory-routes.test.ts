// Fork-patch tests for read-only agent memory browser.
// Interim surface per https://github.com/paperclipai/paperclip/issues/3960.

import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
}));

// Import after mocks so the factory is applied.
const { agentMemoryRoutes, validateRelativePath } = await import("../routes/agent-memory.js");

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function createTmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupMemoryRoot(root: string) {
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  return path.join(root, "memory");
}

function createApp(memoryRoot: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use(
    "/api",
    agentMemoryRoutes({} as any, {
      resolveAgentMemoryRoot: () => memoryRoot,
      fileByteCap: 1024,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("validateRelativePath", () => {
  it("rejects empty strings", () => {
    expect(() => validateRelativePath("")).toThrowError(/Path is required/);
  });

  it("rejects traversal segments", () => {
    expect(() => validateRelativePath("../etc/passwd")).toThrowError(/Traversal/);
    expect(() => validateRelativePath("foo/../../bar")).toThrowError(/Traversal/);
  });

  it("rejects absolute paths", () => {
    expect(() => validateRelativePath("/etc/passwd")).toThrowError(/Absolute/);
  });

  it("rejects null bytes", () => {
    expect(() => validateRelativePath("foo\0bar.md")).toThrowError(/null byte/);
  });

  it("normalizes leading slashes and collapses empty segments", () => {
    // Leading `/` triggers the absolute-path guard before normalization.
    expect(() => validateRelativePath("/foo.md")).toThrowError(/Absolute/);
    expect(validateRelativePath("foo//bar.md")).toBe("foo/bar.md");
    expect(validateRelativePath("./foo.md")).toBe("foo.md");
  });
});

describe("agent memory routes", () => {
  let tmpDir: string;
  let memoryRoot: string;
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = createTmpDir("agent-memory-test-");
    memoryRoot = setupMemoryRoot(tmpDir);
    fs.writeFileSync(path.join(memoryRoot, "2026-04-18.md"), "# today\n");
    fs.mkdirSync(path.join(memoryRoot, "life", "areas"), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, "life", "areas", "work.md"), "# work\n");

    mockAgentService.getById.mockResolvedValue({
      id: AGENT_ID,
      companyId: COMPANY_ID,
      adapterConfig: {},
    });

    app = createApp(memoryRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists memory files recursively", async () => {
    const res = await request(app).get(`/api/agents/${AGENT_ID}/memory-files`);
    expect(res.status).toBe(200);
    const paths = (res.body.entries as { path: string; isDir: boolean }[]).map((e) => e.path);
    expect(paths).toContain("2026-04-18.md");
    expect(paths).toContain("life");
    expect(paths).toContain("life/areas");
    expect(paths).toContain("life/areas/work.md");
  });

  it("returns a file's bytes with a markdown content-type", async () => {
    const res = await request(app).get(`/api/agents/${AGENT_ID}/memory-files/2026-04-18.md`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    expect(res.text).toBe("# today\n");
  });

  it("returns 404 when the agent does not exist", async () => {
    mockAgentService.getById.mockResolvedValueOnce(null);
    const res = await request(app).get(`/api/agents/${AGENT_ID}/memory-files`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for traversal attempts", async () => {
    // Express normalizes the URL before routing, so we craft the request
    // manually to prevent the client from collapsing `..`.
    const res = await request(app)
      .get(`/api/agents/${AGENT_ID}/memory-files/%2E%2E%2Fsecret.md`);
    expect(res.status).toBe(400);
  });

  it("returns 400 for null bytes in the path", async () => {
    const res = await request(app)
      .get(`/api/agents/${AGENT_ID}/memory-files/foo%00bar.md`);
    expect(res.status).toBe(400);
  });

  it("returns 403 when a symlink escapes the memory root", async () => {
    const outside = path.join(tmpDir, "outside.md");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(memoryRoot, "escape.md"));
    const res = await request(app).get(`/api/agents/${AGENT_ID}/memory-files/escape.md`);
    expect(res.status).toBe(403);
  });

  it("does not include escaping symlinks in listings", async () => {
    const outside = path.join(tmpDir, "outside.md");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(memoryRoot, "escape.md"));
    const res = await request(app).get(`/api/agents/${AGENT_ID}/memory-files`);
    expect(res.status).toBe(200);
    const paths = (res.body.entries as { path: string }[]).map((e) => e.path);
    expect(paths).not.toContain("escape.md");
  });

  it("returns 413 when the file exceeds the byte cap", async () => {
    fs.writeFileSync(path.join(memoryRoot, "big.md"), Buffer.alloc(2048, 0x61));
    const res = await request(app).get(`/api/agents/${AGENT_ID}/memory-files/big.md`);
    expect(res.status).toBe(413);
  });

  it("returns 400 for directory reads", async () => {
    const res = await request(app).get(`/api/agents/${AGENT_ID}/memory-files/life`);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the memory directory does not exist", async () => {
    fs.rmSync(memoryRoot, { recursive: true, force: true });
    const res = await request(app).get(`/api/agents/${AGENT_ID}/memory-files`);
    expect(res.status).toBe(404);
  });

  it("rejects agents on other companies", async () => {
    mockAgentService.getById.mockResolvedValueOnce({
      id: AGENT_ID,
      companyId: "other-company",
      adapterConfig: {},
    });
    const res = await request(app).get(`/api/agents/${AGENT_ID}/memory-files`);
    expect(res.status).toBe(403);
  });
});

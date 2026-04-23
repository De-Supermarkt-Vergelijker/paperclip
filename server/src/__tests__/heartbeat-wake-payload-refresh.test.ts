import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { refreshWakePayloadCommentIds } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-payload refresh tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("refreshWakePayloadCommentIds (AIU-513)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let issueId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-payload-refresh-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wake refresh test",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
  }

  async function insertComment(body: string, createdAt: Date) {
    const [row] = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorAgentId: agentId,
        body,
        createdAt,
      })
      .returning();
    return row;
  }

  it("refreshes and flags session-stale when queue delay exceeds threshold and new comments landed", async () => {
    await seed();
    const t0 = new Date(Date.now() - 120_000); // 2 min ago
    const t1 = new Date(Date.now() - 60_000); //  1 min ago (after enqueue, before dispatch)
    const enqueueComment = await insertComment("enqueue-time", t0);
    const postEnqueueComment = await insertComment("post-enqueue", t1);

    const result = await refreshWakePayloadCommentIds({
      db,
      companyId,
      issueId,
      contextSnapshot: { wakeCommentIds: [enqueueComment.id] },
      queueDelayMs: 90_000, // well above 30s
    });

    expect(result.refreshAttempted).toBe(true);
    expect(result.additionalCommentIds).toEqual([postEnqueueComment.id]);
    expect(result.sessionIsStale).toBe(true);
    expect(result.snapshotCommentCount).toBe(1);
  });

  it("does not refresh when queue delay exceeds threshold but no new comments landed", async () => {
    await seed();
    const t0 = new Date(Date.now() - 120_000);
    const enqueueComment = await insertComment("only comment", t0);

    const result = await refreshWakePayloadCommentIds({
      db,
      companyId,
      issueId,
      contextSnapshot: { wakeCommentIds: [enqueueComment.id] },
      queueDelayMs: 90_000,
    });

    expect(result.refreshAttempted).toBe(true);
    expect(result.additionalCommentIds).toEqual([]);
    expect(result.sessionIsStale).toBe(false);
  });

  it("skips refresh entirely when queue delay is under threshold", async () => {
    await seed();
    const t0 = new Date(Date.now() - 10_000);
    const t1 = new Date(Date.now() - 5_000);
    const enqueueComment = await insertComment("enqueue-time", t0);
    await insertComment("post-enqueue but fast queue", t1);

    const result = await refreshWakePayloadCommentIds({
      db,
      companyId,
      issueId,
      contextSnapshot: { wakeCommentIds: [enqueueComment.id] },
      queueDelayMs: 5_000, // below 30s
    });

    expect(result.refreshAttempted).toBe(false);
    expect(result.additionalCommentIds).toEqual([]);
    expect(result.sessionIsStale).toBe(false);
  });

  it("skips refresh when snapshot has no comment ids (timer wake)", async () => {
    await seed();
    const t1 = new Date(Date.now() - 10_000);
    await insertComment("historical", t1);

    const result = await refreshWakePayloadCommentIds({
      db,
      companyId,
      issueId,
      contextSnapshot: {},
      queueDelayMs: 90_000,
    });

    expect(result.refreshAttempted).toBe(false);
    expect(result.additionalCommentIds).toEqual([]);
    expect(result.sessionIsStale).toBe(false);
  });

  it("returns existing ids as watermark source and ignores comments that are already in the snapshot", async () => {
    await seed();
    const t0 = new Date(Date.now() - 180_000);
    const t1 = new Date(Date.now() - 120_000);
    const t2 = new Date(Date.now() - 60_000);
    const c0 = await insertComment("older", t0);
    const c1 = await insertComment("middle", t1);
    const c2 = await insertComment("newest", t2);

    // Snapshot already carries c1 — c0 predates it, c2 post-dates it.
    const result = await refreshWakePayloadCommentIds({
      db,
      companyId,
      issueId,
      contextSnapshot: { wakeCommentIds: [c1.id] },
      queueDelayMs: 60_000,
    });

    expect(result.refreshAttempted).toBe(true);
    expect(result.additionalCommentIds).toEqual([c2.id]);
    expect(result.sessionIsStale).toBe(true);
    // c0 must never leak in — it predates the snapshot watermark.
    expect(result.additionalCommentIds).not.toContain(c0.id);
  });
});

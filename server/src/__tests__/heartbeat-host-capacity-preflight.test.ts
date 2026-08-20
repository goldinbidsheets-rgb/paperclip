import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  HOST_CAPACITY_BLOCK_ERROR_CODE,
  HOST_CAPACITY_MIN_FREE_BYTES_ENV,
  HOST_CAPACITY_PATH_ENV,
} from "../services/host-capacity-preflight.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres host-capacity preflight tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat host capacity preflight", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousFloor: string | undefined;
  let previousPath: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-host-capacity-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    previousFloor = process.env[HOST_CAPACITY_MIN_FREE_BYTES_ENV];
    previousPath = process.env[HOST_CAPACITY_PATH_ENV];
    process.env[HOST_CAPACITY_MIN_FREE_BYTES_ENV] = "170141183460469231731687303715884105727";
    process.env[HOST_CAPACITY_PATH_ENV] = process.cwd();
  });

  afterEach(async () => {
    if (previousFloor === undefined) delete process.env[HOST_CAPACITY_MIN_FREE_BYTES_ENV];
    else process.env[HOST_CAPACITY_MIN_FREE_BYTES_ENV] = previousFloor;
    if (previousPath === undefined) delete process.env[HOST_CAPACITY_PATH_ENV];
    else process.env[HOST_CAPACITY_PATH_ENV] = previousPath;

    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("blocks one queued run exactly once when two Windows dispatches race", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Capacity Guard Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Capacity Guard Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Preserve this work",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });

    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]);
    await heartbeat.resumeQueuedRuns();

    const run = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({
      id: runId,
      status: "failed",
      errorCode: HOST_CAPACITY_BLOCK_ERROR_CODE,
      startedAt: null,
      processPid: null,
      processStartedAt: null,
    });
    expect(run?.resultJson).toMatchObject({
      stopReason: HOST_CAPACITY_BLOCK_ERROR_CODE,
      hostCapacityPreflight: {
        version: 1,
        reason: "below_floor",
        minimumFreeBytes: process.env[HOST_CAPACITY_MIN_FREE_BYTES_ENV],
      },
    });

    const events = await db
      .select()
      .from(heartbeatRunEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runId,
      eventType: "lifecycle",
      level: "error",
    });
    expect(events[0]?.payload).toMatchObject({
      reason: "below_floor",
      minimumFreeBytes: process.env[HOST_CAPACITY_MIN_FREE_BYTES_ENV],
    });

    const activities = await db.select().from(activityLog);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      actorType: "system",
      actorId: "host_capacity_preflight",
      action: "heartbeat.host_capacity_preflight_blocked",
      entityType: "heartbeat_run",
      entityId: runId,
      agentId,
      runId,
    });
    expect(activities[0]?.details).toMatchObject({
      issueId,
      blockedBeforeAdapterInvocation: true,
      reason: "below_floor",
      minimumFreeBytes: process.env[HOST_CAPACITY_MIN_FREE_BYTES_ENV],
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({ status: "failed" });

    const issue = await db
      .select()
      .from(issues)
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      id: issueId,
      status: "todo",
      executionRunId: null,
      checkoutRunId: null,
    });
  });
});

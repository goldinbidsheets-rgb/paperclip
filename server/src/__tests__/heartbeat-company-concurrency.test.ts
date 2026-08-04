import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  workspaceOperations,
} from "@paperclipai/db";
import { updateCompanySchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { companyService } from "../services/companies.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { claimQueuedHeartbeatRunWithinLimits } from "../services/heartbeat-run-concurrency.ts";

const adapterHarness = vi.hoisted(() => ({
  execute: vi.fn(),
  releases: [] as Array<() => void>,
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: adapterHarness.execute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company heartbeat concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

function adapterSuccess() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Company concurrency test run completed.",
    provider: "test",
    model: "test-model",
  };
}

describeEmbeddedPostgres("company heartbeat concurrency cap", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-heartbeat-cap-");
    db = createDb(tempDb.connectionString);
  }, 300_000);

  beforeEach(() => {
    adapterHarness.execute.mockReset();
    adapterHarness.releases.length = 0;
    adapterHarness.execute.mockImplementation(() => new Promise((resolve) => {
      adapterHarness.releases.push(() => resolve(adapterSuccess()));
    }));
    heartbeat = heartbeatService(db);
  });

  afterEach(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      adapterHarness.releases.splice(0).forEach((release) => release());
      const activeRuns = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "running"));
      if (activeRuns.length === 0 && adapterHarness.releases.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const runIds = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    await Promise.all(runIds.map(({ id }) => heartbeat.waitForRunExecutionDrain(id)));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("serializes cross-agent promotions so no more than 30 runs become running", async () => {
    const companyId = randomUUID();
    const agentIds = [randomUUID(), randomUUID()];

    await db.insert(companies).values({
      id: companyId,
      name: "Goldin Solar",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    const updatedCompany = await companyService(db).update(companyId, {
      maxConcurrentHeartbeatRuns: 30,
    });
    expect(updatedCompany?.maxConcurrentHeartbeatRuns).toBe(30);
    await db.insert(agents).values(agentIds.map((agentId, index) => ({
      id: agentId,
      companyId,
      name: `Agent ${index + 1}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 20 }, preserved: `agent-${index + 1}` },
      permissions: {},
    })));

    const queuedRuns = Array.from({ length: 32 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      agentId: agentIds[index % agentIds.length]!,
      invocationSource: "automation" as const,
      triggerDetail: "system" as const,
      status: "queued" as const,
      responsibleUserId: "responsible-user",
    }));
    await db.insert(heartbeatRuns).values(queuedRuns);

    const results = await Promise.all(queuedRuns.map((run) =>
      claimQueuedHeartbeatRunWithinLimits(db, {
        runId: run.id,
        companyId,
        agentId: run.agentId,
        maxConcurrentRunsForAgent: 20,
        responsibleUserId: "responsible-user",
        startedAt: null,
      })));

    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(30);
    const running = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    const queued = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));
    expect(running).toHaveLength(30);
    expect(queued).toHaveLength(2);
    for (const agentId of agentIds) {
      expect(running.filter((run) => run.agentId === agentId).length).toBeLessThanOrEqual(20);
    }

    const completedRun = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .limit(1)
      .then((rows) => rows[0]!);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, completedRun.id));

    const overflowRun = queuedRuns.find((run) => queued.some((queuedRow) => queuedRow.id === run.id))!;
    const drained = await claimQueuedHeartbeatRunWithinLimits(db, {
      runId: overflowRun.id,
      companyId,
      agentId: overflowRun.agentId,
      maxConcurrentRunsForAgent: 20,
      responsibleUserId: "responsible-user",
      startedAt: null,
    });
    expect(drained.kind).toBe("claimed");
    const runningAfterDrain = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    expect(runningAfterDrain).toHaveLength(30);

    expect(updateCompanySchema.parse({ maxConcurrentHeartbeatRuns: 30 })).toEqual({
      maxConcurrentHeartbeatRuns: 30,
    });
    const companyAfterServiceRestart = await companyService(db).getById(companyId);
    expect(companyAfterServiceRestart?.maxConcurrentHeartbeatRuns).toBe(30);
  });

  it("keeps cross-agent overflow queued and promotes it when a company slot is released", async () => {
    const companyId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Single Slot Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      maxConcurrentHeartbeatRuns: 1,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "First Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 }, preserved: "first" },
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "Second Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 }, preserved: "second" },
        permissions: {},
      },
    ]);

    const firstRun = await heartbeat.invoke(firstAgentId, "on_demand", {}, "system");
    expect(firstRun).not.toBeNull();
    expect(await waitForCondition(async () => {
      const run = await heartbeat.getRun(firstRun!.id);
      return run?.status === "running";
    })).toBe(true);
    expect(await waitForCondition(
      async () => adapterHarness.execute.mock.calls.length === 1,
      30_000,
    )).toBe(true);

    const secondRun = await heartbeat.invoke(secondAgentId, "on_demand", {}, "system");
    expect(secondRun).not.toBeNull();
    expect((await heartbeat.getRun(secondRun!.id))?.status).toBe("queued");
    expect(adapterHarness.execute).toHaveBeenCalledTimes(1);

    adapterHarness.releases.shift()!();
    expect(await waitForCondition(async () => {
      const run = await heartbeat.getRun(secondRun!.id);
      return run?.status === "running";
    }, 10_000)).toBe(true);
    expect(await waitForCondition(
      async () => adapterHarness.execute.mock.calls.length === 2,
      30_000,
    )).toBe(true);

    const savedConfigs = await db
      .select({ id: agents.id, runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.status, "running")));
    expect(savedConfigs).toHaveLength(1);
    expect(savedConfigs[0]?.runtimeConfig).toMatchObject({
      heartbeat: { maxConcurrentRuns: 1 },
      preserved: "second",
    });

    adapterHarness.releases.shift()!();
    expect(await waitForCondition(async () => {
      const run = await heartbeat.getRun(secondRun!.id);
      return run?.status === "succeeded";
    }, 10_000)).toBe(true);
  }, 60_000);
});

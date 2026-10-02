import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "../../server/node_modules/drizzle-orm/index.js";
import { createDb, closeRegisteredClients, heartbeatRuns, agentWakeupRequests, issues } from "../../packages/db/src/index.ts";

const observations: unknown[] = [];
// Buffer existing responses only: no extra request or await in the 3s search.
export function observe(kind: string, data: unknown) {
  observations.push({ at: new Date().toISOString(), kind, data });
}
export async function captureSignoff(companyId: string, issueIds: string[]) {
  const directory = process.env.DIAGNOSTIC_OUTPUT!;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "signoff-observations.json"), JSON.stringify(observations, null, 2));
  const configPath = path.resolve(process.env.PAPERCLIP_E2E_SERVER_CONFIG!);
  const relative = path.relative(os.tmpdir(), configPath);
  if (!relative.startsWith("paperclip-e2e-home-") || relative.startsWith("..")) throw new Error("Not a throwaway e2e config");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const dataDir = path.resolve(config.database.embeddedPostgresDataDir);
  const home = path.join(os.tmpdir(), relative.split(path.sep)[0]);
  if (path.relative(home, dataDir).startsWith("..")) throw new Error("Database outside throwaway home");
  const pid = await readFile(path.join(dataDir, "postmaster.pid"), "utf8");
  const port = Number(pid.split("\n")[3]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture database port");
  const databaseUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  const db = createDb(databaseUrl);
  try {
    const runRows = await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status, wakeupRequestId: heartbeatRuns.wakeupRequestId,
      contextSnapshot: heartbeatRuns.contextSnapshot, createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
      errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).limit(500);
    const runs = runRows.filter((row) => issueIds.includes(String(row.contextSnapshot?.issueId ?? row.contextSnapshot?.taskId)))
      .map(({ contextSnapshot, ...row }) => ({ ...row, issueId: contextSnapshot?.issueId, taskId: contextSnapshot?.taskId }));
    const wakeRows = await db.select({ id: agentWakeupRequests.id, agentId: agentWakeupRequests.agentId,
      status: agentWakeupRequests.status, runId: agentWakeupRequests.runId, reason: agentWakeupRequests.reason,
      payload: agentWakeupRequests.payload, requestedAt: agentWakeupRequests.requestedAt,
      claimedAt: agentWakeupRequests.claimedAt, finishedAt: agentWakeupRequests.finishedAt
    }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)).limit(500);
    const wakes = wakeRows.filter((row) => issueIds.includes(String(row.payload?.issueId ?? row.payload?.taskId)) || runs.some((run) => run.wakeupRequestId === row.id))
      .map(({ payload, ...row }) => ({ ...row, issueId: payload?.issueId, taskId: payload?.taskId }));
    const states = (await db.select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
      executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId,
      executionPolicy: issues.executionPolicy, executionState: issues.executionState
    }).from(issues).where(eq(issues.companyId, companyId))).filter((row) => issueIds.includes(row.id));
    await writeFile(path.join(directory, "signoff-database.json"), JSON.stringify({ capturedAt: new Date().toISOString(),
      companyId, issueIds, states, runs, wakes, limitReached: runRows.length === 500 || wakeRows.length === 500 }, null, 2));
  } finally { await closeRegisteredClients(databaseUrl); }
}

import type {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";

// Queued retries can legitimately wait behind long agent runs. Require a
// materially overdue hour after both eligibility and the latest observed
// started sibling's completion (a capacity release), in addition to the
// no-active-run classifier gate.
export const STALE_QUEUED_EXECUTION_LOCK_GRACE_MS = 60 * 60 * 1000;
export const STALE_QUEUED_EXECUTION_LOCK_ERROR_CODE = "stale_queued_execution_lock";

type IssueExecutionLock = Pick<
  typeof issues.$inferSelect,
  "id" | "executionRunId"
>;

type QueuedRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  | "id"
  | "status"
  | "wakeupRequestId"
  | "createdAt"
  | "scheduledRetryAt"
  | "startedAt"
  | "finishedAt"
  | "exitCode"
  | "signal"
  | "externalRunId"
  | "processPid"
  | "processGroupId"
  | "processStartedAt"
  | "logStore"
  | "logRef"
  | "logBytes"
  | "logSha256"
  | "stdoutExcerpt"
  | "stderrExcerpt"
  | "lastOutputAt"
  | "lastOutputSeq"
  | "lastOutputStream"
  | "lastOutputBytes"
>;

type QueuedWakeup = Pick<
  typeof agentWakeupRequests.$inferSelect,
  "id" | "runId" | "status" | "claimedAt" | "finishedAt"
>;

export type StaleQueuedExecutionLockClassification =
  | { stale: false }
  | {
      stale: true;
      eligibilityAt: Date;
      graceAnchorAt: Date;
      agentLatestFinishedRunAt: Date | null;
      staleAt: Date;
      graceMs: number;
    };

function hasExecutionEvidence(run: QueuedRun) {
  return run.startedAt !== null
    || run.finishedAt !== null
    || run.exitCode !== null
    || run.signal !== null
    || run.externalRunId !== null
    || run.processPid !== null
    || run.processGroupId !== null
    || run.processStartedAt !== null
    || run.logStore !== null
    || run.logRef !== null
    || (run.logBytes !== null && run.logBytes > 0)
    || run.logSha256 !== null
    || run.stdoutExcerpt !== null
    || run.stderrExcerpt !== null
    || run.lastOutputAt !== null
    || run.lastOutputSeq !== 0
    || run.lastOutputStream !== null
    || (run.lastOutputBytes !== null && run.lastOutputBytes > 0);
}

/**
 * Classifies the legacy lock shape conservatively. Callers use this exact
 * predicate both before row locking and after all three rows are locked.
 */
export function classifyStaleQueuedExecutionLock(input: {
  issue: IssueExecutionLock;
  run: QueuedRun;
  wakeup: QueuedWakeup | null;
  agentHasRunningRun: boolean;
  agentLatestFinishedRunAt: Date | null;
  now: Date;
}): StaleQueuedExecutionLockClassification {
  const {
    issue,
    run,
    wakeup,
    agentHasRunningRun,
    agentLatestFinishedRunAt,
    now,
  } = input;

  if (issue.executionRunId !== run.id || run.status !== "queued") {
    return { stale: false };
  }
  if (agentHasRunningRun) return { stale: false };
  if (hasExecutionEvidence(run)) return { stale: false };
  if (
    !run.wakeupRequestId
    || !wakeup
    || wakeup.id !== run.wakeupRequestId
    || wakeup.runId !== run.id
    || wakeup.status !== "queued"
    || wakeup.claimedAt !== null
    || wakeup.finishedAt !== null
  ) {
    return { stale: false };
  }

  const eligibilityAt = run.scheduledRetryAt ?? run.createdAt;
  const eligibilityMs = eligibilityAt.getTime();
  if (!Number.isFinite(eligibilityMs)) return { stale: false };
  const latestFinishedMs = agentLatestFinishedRunAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const graceAnchorAt = Number.isFinite(latestFinishedMs) && latestFinishedMs > eligibilityMs
    ? agentLatestFinishedRunAt!
    : eligibilityAt;
  const staleAt = new Date(graceAnchorAt.getTime() + STALE_QUEUED_EXECUTION_LOCK_GRACE_MS);
  if (now.getTime() < staleAt.getTime()) return { stale: false };

  return {
    stale: true,
    eligibilityAt,
    graceAnchorAt,
    agentLatestFinishedRunAt,
    staleAt,
    graceMs: STALE_QUEUED_EXECUTION_LOCK_GRACE_MS,
  };
}

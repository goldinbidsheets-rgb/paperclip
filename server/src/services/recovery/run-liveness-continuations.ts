import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues } from "@paperclipai/db";
import type { RunLivenessState } from "@paperclipai/shared";
import {
  type IssueThrottleCeilingDecision,
  type IssueThrottleExitSummary,
  type LivenessContinuationBackoffConfig,
  buildIssueThrottleCeilingIdempotencyKey,
  buildIssueThrottleCeilingNotice,
  computeLivenessContinuationBackoff,
  decideIssueThrottleCeiling,
} from "./liveness-continuation-throttle.js";
import { withRecoveryModelProfileHint } from "./model-profile-hint.js";
import { RECOVERY_REASON_KINDS } from "./origins.js";

export const RUN_LIVENESS_CONTINUATION_REASON = RECOVERY_REASON_KINDS.runLivenessContinuation;
export const DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS = 2;

const ACTIONABLE_LIVENESS_STATES = new Set<RunLivenessState>(["plan_only", "empty_response"]);
const CONTINUATION_ACTIVE_ISSUE_STATUSES = new Set(["todo", "in_progress"]);
// A prior adapter error should not permanently suppress bounded liveness
// continuations; the max-attempt/idempotency guards prevent unbounded retries.
const CONTINUATION_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);
const IDEMPOTENT_WAKE_STATUSES = ["queued", "deferred_issue_execution", "completed"];

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type IssueRow = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "identifier" | "title" | "status" | "assigneeAgentId" | "executionState" | "projectId"
>;
type AgentRow = Pick<typeof agents.$inferSelect, "id" | "companyId" | "status">;

export type RunContinuationBackoff = {
  delayMs: number;
  notBefore: string;
};

export type RunContinuationDecision =
  | {
      kind: "enqueue";
      nextAttempt: number;
      idempotencyKey: string;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
      // Populated when a backoff config is supplied; the caller decides
      // whether to honor it (enforce) or only log it (shadow).
      backoff: RunContinuationBackoff | null;
      // Per-issue rolling-window throttle-ceiling evaluation. In shadow mode a
      // tripped ceiling still returns kind "enqueue" with throttle.tripped set
      // so the caller can log the would-pause without changing behavior.
      throttle: IssueThrottleCeilingDecision | null;
    }
  | {
      kind: "exhausted";
      attempt: number;
      maxAttempts: number;
      comment: string;
    }
  | {
      // Enforce mode only: K consecutive upstream-throttle exits for this
      // issue inside the rolling window. The caller pauses the agent and files
      // the consolidated notice exactly once per burst (idempotencyKey).
      kind: "throttle_paused";
      consecutive: number;
      ceiling: number;
      windowMs: number;
      idempotencyKey: string;
      comment: string;
    }
  | {
      kind: "skip";
      reason: string;
    };

export function readContinuationAttempt(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

export function buildRunLivenessContinuationIdempotencyKey(input: {
  issueId: string;
  sourceRunId: string;
  livenessState: RunLivenessState;
  nextAttempt: number;
}) {
  return [
    RUN_LIVENESS_CONTINUATION_REASON,
    input.issueId,
    input.sourceRunId,
    input.livenessState,
    String(input.nextAttempt),
  ].join(":");
}

export async function findExistingRunLivenessContinuationWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, IDEMPOTENT_WAKE_STATUSES),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export function decideRunLivenessContinuation(input: {
  run: HeartbeatRunRow;
  issue: IssueRow | null;
  agent: AgentRow | null;
  livenessState: RunLivenessState | null;
  livenessReason: string | null;
  nextAction: string | null;
  budgetBlocked: boolean;
  idempotentWakeExists: boolean;
  maxAttempts?: number;
  now?: Date;
  backoffConfig?: LivenessContinuationBackoffConfig | null;
  issueThrottleExits?: IssueThrottleExitSummary | null;
}): RunContinuationDecision {
  const {
    run,
    issue,
    agent,
    livenessState,
    livenessReason,
    nextAction,
    budgetBlocked,
    idempotentWakeExists,
  } = input;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS;
  const now = input.now ?? new Date();
  const backoffConfig = input.backoffConfig ?? null;

  if (!livenessState || !ACTIONABLE_LIVENESS_STATES.has(livenessState)) {
    return { kind: "skip", reason: "liveness state is not actionable for continuation" };
  }
  if (!issue) return { kind: "skip", reason: "issue not found" };
  if (!agent) return { kind: "skip", reason: "agent not found" };
  if (issue.companyId !== run.companyId || agent.companyId !== run.companyId) {
    return { kind: "skip", reason: "company scope mismatch" };
  }
  if (issue.assigneeAgentId !== run.agentId) {
    return { kind: "skip", reason: "issue is no longer assigned to the source run agent" };
  }
  if (!CONTINUATION_ACTIVE_ISSUE_STATUSES.has(issue.status)) {
    return { kind: "skip", reason: `issue status ${issue.status} is not continuable` };
  }
  if (issue.executionState) {
    return { kind: "skip", reason: "issue is blocked by execution policy state" };
  }
  if (!CONTINUATION_AGENT_STATUSES.has(agent.status)) {
    return { kind: "skip", reason: `agent status ${agent.status} is not invokable` };
  }
  if (budgetBlocked) {
    return { kind: "skip", reason: "budget hard stop blocks continuation" };
  }

  // Per-issue rolling-window ceiling: the per-source-run attempt cap below
  // resets whenever a fresh wake starts a new source run, so a repeated
  // upstream throttle can burst forever across source runs. K consecutive
  // throttle exits inside the window is the real blocker (quota/rate-limit)
  // and stops continuation for this issue entirely under enforce mode.
  const throttle =
    backoffConfig && input.issueThrottleExits
      ? decideIssueThrottleCeiling(input.issueThrottleExits, backoffConfig)
      : null;
  if (throttle?.tripped && backoffConfig?.mode === "enforce") {
    const idempotencyKey = buildIssueThrottleCeilingIdempotencyKey({
      issueId: issue.id,
      firstExitAt: input.issueThrottleExits?.firstExitAt ?? now,
    });
    return {
      kind: "throttle_paused",
      consecutive: throttle.consecutive,
      ceiling: throttle.ceiling,
      windowMs: throttle.windowMs,
      idempotencyKey,
      comment: buildIssueThrottleCeilingNotice({
        issueIdentifier: issue.identifier ?? null,
        consecutive: throttle.consecutive,
        ceiling: throttle.ceiling,
        windowMs: throttle.windowMs,
        kinds: input.issueThrottleExits?.kinds ?? [],
        idempotencyKey,
      }),
    };
  }

  const currentAttempt = readContinuationAttempt(run.continuationAttempt);
  if (currentAttempt >= maxAttempts) {
    return {
      kind: "exhausted",
      attempt: currentAttempt,
      maxAttempts,
      comment: [
        "Bounded liveness continuation exhausted",
        "",
        `- Last liveness state: \`${livenessState}\``,
        `- Attempts used: ${currentAttempt}/${maxAttempts}`,
        `- Reason: ${livenessReason ?? "Run ended without concrete progress"}`,
        "- Next action: a human or manager should inspect the run and either clarify the task, mark it blocked, or assign a concrete follow-up.",
      ].join("\n"),
    };
  }

  const nextAttempt = currentAttempt + 1;
  const idempotencyKey = buildRunLivenessContinuationIdempotencyKey({
    issueId: issue.id,
    sourceRunId: run.id,
    livenessState,
    nextAttempt,
  });
  if (idempotentWakeExists) {
    return { kind: "skip", reason: "continuation wake already exists for this source run and attempt" };
  }

  const payload = withRecoveryModelProfileHint({
    issueId: issue.id,
    sourceRunId: run.id,
    livenessState,
    livenessReason,
    continuationAttempt: nextAttempt,
    maxContinuationAttempts: maxAttempts,
    instruction:
      nextAction ??
      "The previous run ended without concrete progress. Take the first concrete action now or mark the issue blocked with a specific unblock request.",
  }, "normal_model");

  // The continuation itself backs off exponentially instead of firing
  // immediately; the caller defers by delayMs under enforce mode and only
  // logs the computed schedule under shadow mode.
  const backoffSchedule =
    backoffConfig && backoffConfig.mode !== "off"
      ? computeLivenessContinuationBackoff(nextAttempt, backoffConfig, now)
      : null;

  return {
    kind: "enqueue",
    nextAttempt,
    idempotencyKey,
    backoff: backoffSchedule
      ? { delayMs: backoffSchedule.delayMs, notBefore: backoffSchedule.notBefore.toISOString() }
      : null,
    throttle,
    payload,
    contextSnapshot: withRecoveryModelProfileHint({
      issueId: issue.id,
      taskId: issue.id,
      taskKey: issue.id,
      wakeReason: RUN_LIVENESS_CONTINUATION_REASON,
      livenessContinuationAttempt: nextAttempt,
      livenessContinuationMaxAttempts: maxAttempts,
      livenessContinuationSourceRunId: run.id,
      livenessContinuationState: livenessState,
      livenessContinuationReason: livenessReason,
      livenessContinuationInstruction: payload.instruction,
    }, "normal_model"),
  };
}

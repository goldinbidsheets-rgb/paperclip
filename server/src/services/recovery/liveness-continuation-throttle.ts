// Layer C of the adapter retry-storm hardening: every automatic continuation
// path must be bounded by backoff plus a per-issue ceiling, because the
// existing per-source-run cap (DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS)
// resets to zero whenever a fresh wake starts a new source run — a laundered
// upstream 429 can therefore loop "immediate continuation → empty run →
// immediate continuation" indefinitely across source runs.
//
// This module is intentionally dependency-free (no db/drizzle imports) so the
// decision logic can be unit-tested in isolation. Rollout is flag-gated via
// LIVENESS_CONTINUATION_BACKOFF_MODE: "off" preserves today's behavior,
// "shadow" (default) computes and logs what would happen without changing
// behavior, "enforce" defers continuations by the computed backoff and pauses
// the agent with one consolidated notice when the per-issue ceiling trips.

export const LIVENESS_CONTINUATION_BACKOFF_MODES = ["off", "shadow", "enforce"] as const;
export type LivenessContinuationBackoffMode = (typeof LIVENESS_CONTINUATION_BACKOFF_MODES)[number];

// Liveness state emitted by the retryable-upstream classifier layer for runs
// that exited cleanly after an upstream 429/quota error. Kept as a local
// constant so this layer stays landable independently of that classifier:
// until the classifier ships, no run carries this state and the checks below
// simply never match it.
export const UPSTREAM_THROTTLED_LIVENESS_STATE = "upstream_throttled" as const;

export const TRANSIENT_UPSTREAM_ERROR_FAMILY = "transient_upstream" as const;

const TRANSIENT_UPSTREAM_ERROR_CODES = new Set([
  "codex_transient_upstream",
  "claude_transient_upstream",
]);

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "timed_out"]);

export const DEFAULT_LIVENESS_CONTINUATION_BACKOFF_BASE_MS = 60_000;
export const DEFAULT_LIVENESS_CONTINUATION_BACKOFF_CAP_MS = 15 * 60_000;
export const DEFAULT_ISSUE_UPSTREAM_THROTTLE_WINDOW_MS = 60 * 60_000;
export const DEFAULT_ISSUE_UPSTREAM_THROTTLE_CEILING = 3;

export interface LivenessContinuationBackoffConfig {
  mode: LivenessContinuationBackoffMode;
  backoffBaseMs: number;
  backoffCapMs: number;
  throttleWindowMs: number;
  throttleCeiling: number;
}

function readPositiveIntEnv(value: string | undefined, fallback: number) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function resolveLivenessContinuationBackoffConfig(
  env: Record<string, string | undefined>,
): LivenessContinuationBackoffConfig {
  const rawMode = (env.LIVENESS_CONTINUATION_BACKOFF_MODE ?? "").trim().toLowerCase();
  const mode = (LIVENESS_CONTINUATION_BACKOFF_MODES as readonly string[]).includes(rawMode)
    ? (rawMode as LivenessContinuationBackoffMode)
    : "shadow";
  const backoffBaseMs = readPositiveIntEnv(
    env.LIVENESS_CONTINUATION_BACKOFF_BASE_MS,
    DEFAULT_LIVENESS_CONTINUATION_BACKOFF_BASE_MS,
  );
  const backoffCapMs = Math.max(
    backoffBaseMs,
    readPositiveIntEnv(
      env.LIVENESS_CONTINUATION_BACKOFF_CAP_MS,
      DEFAULT_LIVENESS_CONTINUATION_BACKOFF_CAP_MS,
    ),
  );
  return {
    mode,
    backoffBaseMs,
    backoffCapMs,
    throttleWindowMs: readPositiveIntEnv(
      env.ISSUE_UPSTREAM_THROTTLE_WINDOW_MS,
      DEFAULT_ISSUE_UPSTREAM_THROTTLE_WINDOW_MS,
    ),
    throttleCeiling: readPositiveIntEnv(
      env.ISSUE_UPSTREAM_THROTTLE_CEILING,
      DEFAULT_ISSUE_UPSTREAM_THROTTLE_CEILING,
    ),
  };
}

export function computeLivenessContinuationBackoff(
  nextAttempt: number,
  config: Pick<LivenessContinuationBackoffConfig, "backoffBaseMs" | "backoffCapMs">,
  now: Date,
) {
  const attempt = Number.isFinite(nextAttempt) && nextAttempt > 1 ? Math.floor(nextAttempt) : 1;
  const exponentialMs = config.backoffBaseMs * 2 ** (attempt - 1);
  const delayMs = Math.min(config.backoffCapMs, exponentialMs);
  return {
    delayMs,
    notBefore: new Date(now.getTime() + delayMs),
  };
}

export type ThrottleExitKind = "transient_upstream" | "upstream_throttled";

export interface ThrottleExitRunLike {
  status?: string | null;
  errorCode?: string | null;
  resultJson?: unknown;
  livenessState?: string | null;
  finishedAt?: Date | string | null;
}

function readRunFinishedAt(run: ThrottleExitRunLike): Date | null {
  if (!run.finishedAt) return null;
  const parsed = run.finishedAt instanceof Date ? run.finishedAt : new Date(run.finishedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readRunThrottleExitKind(run: ThrottleExitRunLike): ThrottleExitKind | null {
  if (run.livenessState === UPSTREAM_THROTTLED_LIVENESS_STATE) return "upstream_throttled";
  const resultJson =
    run.resultJson && typeof run.resultJson === "object" && !Array.isArray(run.resultJson)
      ? (run.resultJson as Record<string, unknown>)
      : null;
  const errorFamily = typeof resultJson?.errorFamily === "string" ? resultJson.errorFamily : null;
  if (errorFamily === TRANSIENT_UPSTREAM_ERROR_FAMILY) return "transient_upstream";
  if (run.errorCode && TRANSIENT_UPSTREAM_ERROR_CODES.has(run.errorCode)) return "transient_upstream";
  return null;
}

export interface IssueThrottleExitSummary {
  // Consecutive throttle exits, newest first, all inside the rolling window.
  // The streak breaks on the first terminal run that is not a throttle exit —
  // productive runs between throttle exits reset the count.
  consecutive: number;
  kinds: ThrottleExitKind[];
  firstExitAt: Date | null;
  lastExitAt: Date | null;
}

export function summarizeIssueThrottleExits(
  runs: ThrottleExitRunLike[],
  input: { now: Date; windowMs: number },
): IssueThrottleExitSummary {
  const terminal = runs
    .filter((run) => run.status && TERMINAL_RUN_STATUSES.has(run.status))
    .map((run) => ({ run, finishedAt: readRunFinishedAt(run) }))
    .filter((entry): entry is { run: ThrottleExitRunLike; finishedAt: Date } => entry.finishedAt !== null)
    .sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());

  const windowStart = input.now.getTime() - input.windowMs;
  const kinds: ThrottleExitKind[] = [];
  let firstExitAt: Date | null = null;
  let lastExitAt: Date | null = null;

  for (const entry of terminal) {
    if (entry.finishedAt.getTime() < windowStart) break;
    const kind = readRunThrottleExitKind(entry.run);
    if (!kind) break;
    kinds.push(kind);
    firstExitAt = entry.finishedAt;
    lastExitAt ??= entry.finishedAt;
  }

  return { consecutive: kinds.length, kinds, firstExitAt, lastExitAt };
}

export interface IssueThrottleCeilingDecision {
  tripped: boolean;
  consecutive: number;
  ceiling: number;
  windowMs: number;
}

export function decideIssueThrottleCeiling(
  summary: IssueThrottleExitSummary,
  config: Pick<LivenessContinuationBackoffConfig, "throttleCeiling" | "throttleWindowMs">,
): IssueThrottleCeilingDecision {
  return {
    tripped: summary.consecutive >= config.throttleCeiling,
    consecutive: summary.consecutive,
    ceiling: config.throttleCeiling,
    windowMs: config.throttleWindowMs,
  };
}

// Keyed on the first exit of the current streak: the key stays stable while
// the same burst continues, so the consolidated notice is filed once per
// burst instead of once per exit.
export function buildIssueThrottleCeilingIdempotencyKey(input: {
  issueId: string;
  firstExitAt: Date;
}) {
  return ["issue-upstream-throttle-ceiling", input.issueId, input.firstExitAt.toISOString()].join(":");
}

export function buildIssueThrottleCeilingNotice(input: {
  issueIdentifier: string | null;
  consecutive: number;
  ceiling: number;
  windowMs: number;
  kinds: ThrottleExitKind[];
  idempotencyKey: string;
}) {
  const windowMinutes = Math.max(1, Math.round(input.windowMs / 60_000));
  const kindCounts = new Map<ThrottleExitKind, number>();
  for (const kind of input.kinds) kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  const kindSummary = [...kindCounts.entries()].map(([kind, count]) => `${kind} ×${count}`).join(", ");
  return [
    "## Upstream throttle ceiling reached — automatic retries paused",
    "",
    `${input.consecutive} consecutive upstream-throttled run exits (${kindSummary || "none classified"}) ` +
      `within the last ${windowMinutes} minutes hit the per-issue ceiling of ${input.ceiling}` +
      `${input.issueIdentifier ? ` on ${input.issueIdentifier}` : ""}.`,
    "",
    "The real blocker is upstream quota / rate-limiting, not the task itself. " +
      "Continuing to retry burns quota without making progress, so automatic " +
      "continuations for this assignee are paused instead of escalating once per retry.",
    "",
    "Next step: a human or manager should restore upstream capacity " +
      "(raise the quota, rotate the credential, or wait out the rate-limit window) " +
      "and then resume the agent.",
    "",
    `<!-- ${input.idempotencyKey} -->`,
  ].join("\n");
}

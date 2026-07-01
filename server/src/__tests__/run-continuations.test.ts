import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
  RUN_LIVENESS_CONTINUATION_REASON,
  UPSTREAM_THROTTLED_LIVENESS_STATE,
  buildIssueThrottleCeilingIdempotencyKey,
  buildRunLivenessContinuationIdempotencyKey,
  decideRunLivenessContinuation,
  resolveLivenessContinuationBackoffConfig,
  summarizeIssueThrottleExits,
} from "../services/run-continuations.ts";
import type { RunLivenessState } from "@paperclipai/shared";

const companyId = "company-1";
const agentId = "agent-1";
const issueId = "issue-1";
const runId = "run-1";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    companyId,
    agentId,
    continuationAttempt: 0,
    ...overrides,
  } as never;
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    identifier: "PAP-1577",
    title: "Add bounded liveness continuation wakes",
    status: "in_progress",
    assigneeAgentId: agentId,
    executionState: null,
    projectId: null,
    ...overrides,
  } as never;
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId,
    status: "idle",
    ...overrides,
  } as never;
}

describe("run liveness continuations", () => {
  it("enqueues the first plan_only continuation for the same issue and assignee", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Planned without acting",
      nextAction: "Take the first concrete action now.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(1);
    expect(decision.idempotencyKey).toBe(
      buildRunLivenessContinuationIdempotencyKey({
        issueId,
        sourceRunId: runId,
        livenessState: "plan_only",
        nextAttempt: 1,
      }),
    );
    expect(decision.payload).toMatchObject({
      issueId,
      sourceRunId: runId,
      livenessState: "plan_only",
      livenessReason: "Planned without acting",
      continuationAttempt: 1,
      maxContinuationAttempts: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      instruction: "Take the first concrete action now.",
    });
    expect(decision.payload).not.toHaveProperty("modelProfile");
    expect(decision.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: RUN_LIVENESS_CONTINUATION_REASON,
      livenessContinuationAttempt: 1,
      livenessContinuationMaxAttempts: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      livenessContinuationSourceRunId: runId,
      livenessContinuationState: "plan_only",
      livenessContinuationReason: "Planned without acting",
      livenessContinuationInstruction: "Take the first concrete action now.",
    });
    expect(decision.contextSnapshot).not.toHaveProperty("modelProfile");
  });

  it("enqueues the second empty_response continuation", () => {
    const decision = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 1 }),
      issue: issue(),
      agent: agent(),
      livenessState: "empty_response",
      livenessReason: "No useful output",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(2);
  });

  it("leaves advanced terminal runs to stranded issue recovery instead of bounded liveness continuation", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: created an issue comment",
      nextAction: "Resume the implementation from the remaining acceptance criteria.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision).toEqual({
      kind: "skip",
      reason: "liveness state is not actionable for continuation",
    });
  });

  it("does not enqueue a third continuation and returns an exhaustion comment", () => {
    const decision = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 2 }),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Still planning",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("exhausted");
    if (decision.kind !== "exhausted") return;
    expect(decision.comment).toContain("Bounded liveness continuation exhausted");
    expect(decision.comment).toContain("Attempts used: 2/2");
  });

  it("skips non-actionable and guarded issues", () => {
    const guardedCases = [
      { livenessState: "advanced" as const },
      { issue: issue({ status: "done" }) },
      { issue: issue({ assigneeAgentId: "other-agent" }) },
      { issue: issue({ executionState: { status: "pending" } }) },
      { agent: agent({ status: "paused" }) },
      { budgetBlocked: true },
      { idempotentWakeExists: true },
    ];

    for (const guarded of guardedCases) {
      const decision = decideRunLivenessContinuation({
        run: run(),
        issue: guarded.issue ?? issue(),
        agent: guarded.agent ?? agent(),
        livenessState: guarded.livenessState ?? "plan_only",
        livenessReason: "No progress",
        nextAction: null,
        budgetBlocked: guarded.budgetBlocked ?? false,
        idempotentWakeExists: guarded.idempotentWakeExists ?? false,
      });

      expect(decision.kind).toBe("skip");
    }
  });
});

describe("liveness continuation backoff and per-issue throttle ceiling (Layer C)", () => {
  const now = new Date("2026-07-01T12:00:00.000Z");
  const shadowConfig = resolveLivenessContinuationBackoffConfig({});
  const enforceConfig = resolveLivenessContinuationBackoffConfig({
    LIVENESS_CONTINUATION_BACKOFF_MODE: "enforce",
  });

  function minutesAgo(minutes: number) {
    return new Date(now.getTime() - minutes * 60_000);
  }

  function throttleExits(count: number) {
    return summarizeIssueThrottleExits(
      Array.from({ length: count }, (_, index) => ({
        status: "failed",
        errorCode: null,
        resultJson: { errorFamily: "transient_upstream" },
        livenessState: null,
        finishedAt: minutesAgo(index * 4 + 1),
      })),
      { now, windowMs: shadowConfig.throttleWindowMs },
    );
  }

  it("treats upstream_throttled as non-actionable for immediate continuation", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: UPSTREAM_THROTTLED_LIVENESS_STATE as RunLivenessState,
      livenessReason: "Upstream 429 after clean exit",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      now,
      backoffConfig: enforceConfig,
      issueThrottleExits: throttleExits(0),
    });

    expect(decision).toEqual({
      kind: "skip",
      reason: "liveness state is not actionable for continuation",
    });
  });

  it("keeps backoff and throttle out of the decision when no config is supplied", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Planned without acting",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.backoff).toBeNull();
    expect(decision.throttle).toBeNull();
  });

  it("computes an exponential backoff schedule for the continuation", () => {
    const first = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Planned without acting",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      now,
      backoffConfig: shadowConfig,
      issueThrottleExits: throttleExits(0),
    });

    expect(first.kind).toBe("enqueue");
    if (first.kind !== "enqueue") return;
    expect(first.backoff).toEqual({
      delayMs: shadowConfig.backoffBaseMs,
      notBefore: new Date(now.getTime() + shadowConfig.backoffBaseMs).toISOString(),
    });

    const second = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 1 }),
      issue: issue(),
      agent: agent(),
      livenessState: "empty_response",
      livenessReason: "No useful output",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      now,
      backoffConfig: shadowConfig,
      issueThrottleExits: throttleExits(0),
    });

    expect(second.kind).toBe("enqueue");
    if (second.kind !== "enqueue") return;
    expect(second.backoff?.delayMs).toBe(shadowConfig.backoffBaseMs * 2);
  });

  it("annotates but does not suppress a tripped ceiling in shadow mode", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "empty_response",
      livenessReason: "No useful output",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      now,
      backoffConfig: shadowConfig,
      issueThrottleExits: throttleExits(shadowConfig.throttleCeiling),
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.throttle).toEqual({
      tripped: true,
      consecutive: shadowConfig.throttleCeiling,
      ceiling: shadowConfig.throttleCeiling,
      windowMs: shadowConfig.throttleWindowMs,
    });
  });

  it("suppresses the continuation with one consolidated notice when the ceiling trips under enforce", () => {
    const exits = throttleExits(enforceConfig.throttleCeiling);
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "empty_response",
      livenessReason: "No useful output",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      now,
      backoffConfig: enforceConfig,
      issueThrottleExits: exits,
    });

    expect(decision.kind).toBe("throttle_paused");
    if (decision.kind !== "throttle_paused") return;
    expect(decision.consecutive).toBe(enforceConfig.throttleCeiling);
    expect(decision.idempotencyKey).toBe(
      buildIssueThrottleCeilingIdempotencyKey({
        issueId,
        firstExitAt: exits.firstExitAt as Date,
      }),
    );
    expect(decision.comment).toContain("Upstream throttle ceiling reached");
    expect(decision.comment).toContain(decision.idempotencyKey);
    expect(decision.comment).toContain("PAP-1577");
  });

  it("does not trip the ceiling below K consecutive exits even under enforce", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "empty_response",
      livenessReason: "No useful output",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      now,
      backoffConfig: enforceConfig,
      issueThrottleExits: throttleExits(enforceConfig.throttleCeiling - 1),
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.throttle?.tripped).toBe(false);
    expect(decision.backoff?.delayMs).toBe(enforceConfig.backoffBaseMs);
  });

  it("closes the new-source-run reset hole: a fresh source run at attempt 0 still hits the per-issue ceiling", () => {
    // Nine consecutive throttle exits across MANY source runs (the storm that
    // produced 9 alarms): each fresh wake resets continuationAttempt to 0, so
    // the per-run cap alone would happily enqueue again.
    const decision = decideRunLivenessContinuation({
      run: run({ id: "run-10", continuationAttempt: 0 }),
      issue: issue(),
      agent: agent(),
      livenessState: "empty_response",
      livenessReason: "No useful output",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      now,
      backoffConfig: enforceConfig,
      issueThrottleExits: throttleExits(9),
    });

    expect(decision.kind).toBe("throttle_paused");
  });
});

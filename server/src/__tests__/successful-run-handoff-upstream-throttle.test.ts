import { describe, expect, it } from "vitest";
import { decideSuccessfulRunHandoff } from "../services/recovery/successful-run-handoff.ts";

const companyId = "company-1";
const agentId = "agent-1";
const issueId = "issue-1";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    run: {
      id: "run-1",
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: {},
      issueCommentStatus: null,
    } as never,
    issue: {
      id: issueId,
      companyId,
      identifier: "PAP-1",
      title: "Do the thing",
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      executionState: null,
    } as never,
    agent: { id: agentId, companyId, status: "idle" } as never,
    livenessState: null,
    detectedProgressSummary: null,
    taskKey: null,
    hasActiveExecutionPath: false,
    hasQueuedWake: false,
    hasPendingInteractionOrApproval: false,
    hasExplicitBlockerPath: false,
    hasOpenRecoveryIssue: false,
    hasPauseHold: false,
    hasActiveRoutineContinuation: false,
    budgetBlocked: false,
    idempotentWakeExists: false,
    ...overrides,
  };
}

describe("successful run handoff — upstream throttle exclusion (GOL-4038 Layer B)", () => {
  it("skips the corrective handoff for upstream_throttled runs even when a progress summary exists", () => {
    const decision = decideSuccessfulRunHandoff(
      baseInput({
        livenessState: "upstream_throttled",
        // The persisted livenessReason surfaces as a detected progress
        // summary; without the explicit exclusion this would count as
        // handoff-relevant progress.
        detectedProgressSummary: "retryable-upstream signature (RESOURCE_EXHAUSTED)",
      }) as never,
    );

    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") return;
    expect(decision.reason).toContain("bounded backoff scheduler");
  });

  it("still enqueues the handoff for productive runs", () => {
    const decision = decideSuccessfulRunHandoff(
      baseInput({
        livenessState: "advanced",
        detectedProgressSummary: "Wrote and pushed the fix.",
      }) as never,
    );

    expect(decision.kind).toBe("enqueue");
  });
});

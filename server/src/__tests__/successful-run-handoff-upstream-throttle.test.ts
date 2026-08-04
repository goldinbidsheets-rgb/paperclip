import { describe, expect, it } from "vitest";
import { decideSuccessfulRunHandoff } from "../services/recovery/successful-run-handoff.ts";

function input(livenessState: "upstream_throttled" | "advanced") {
  return {
    run: {
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "succeeded",
      contextSnapshot: {},
      issueCommentStatus: null,
    } as never,
    issue: {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-1",
      title: "Implement the change",
      description: "Implement and verify the requested behavior.",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      executionState: null,
    } as never,
    agent: { id: "agent-1", companyId: "company-1", status: "idle" } as never,
    livenessState,
    detectedProgressSummary: livenessState === "upstream_throttled"
      ? "retryable-upstream signature (RESOURCE_EXHAUSTED)"
      : "Implemented and verified the change.",
    finalReport: null,
    nextAction: null,
    taskKey: null,
    hasActiveExecutionPath: false,
    hasQueuedWake: false,
    hasPendingInteractionOrApproval: false,
    hasPersistedMonitor: false,
    hasExplicitBlockerPath: false,
    hasOpenRecoveryIssue: false,
    hasPauseHold: false,
    hasActiveRoutineContinuation: false,
    budgetBlocked: false,
    idempotentWakeExists: false,
  };
}

describe("successful-run handoff upstream throttle exclusion", () => {
  it("leaves an upstream_throttled run to the bounded backoff scheduler", () => {
    expect(decideSuccessfulRunHandoff(input("upstream_throttled") as never)).toEqual({
      kind: "skip",
      reason: "run hit a retryable upstream throttle; the bounded backoff scheduler owns the retry path",
    });
  });

  it("preserves the productive successful-run handoff", () => {
    expect(decideSuccessfulRunHandoff(input("advanced") as never).kind).toBe("enqueue");
  });
});

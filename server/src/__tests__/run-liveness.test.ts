import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPSTREAM_THROTTLED_RETRY_DELAY_MS,
  classifyRunLiveness,
  extractRetryableUpstreamRetryDelayMs,
  isUpstreamThrottledBackoffPending,
} from "../services/run-liveness.ts";

const baseInput = {
  runStatus: "succeeded",
  issue: {
    status: "in_progress",
    title: "Implement feature",
    description: "Add the requested behavior.",
  },
  resultJson: null,
  stdoutExcerpt: null,
  stderrExcerpt: null,
  error: null,
  errorCode: null,
  continuationAttempt: 0,
  evidence: null,
};

describe("run liveness classifier", () => {
  it("classifies text-only future work as plan_only", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "I will inspect the repo next and then implement the fix.",
      },
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toContain("inspect the repo");
  });

  it("classifies empty successful output as empty_response", () => {
    const classification = classifyRunLiveness(baseInput);

    expect(classification.livenessState).toBe("empty_response");
    expect(classification.actionability).toBe("unknown");
  });

  it("treats issue comments, documents, products, and actions as progress", () => {
    const latestEvidenceAt = new Date("2026-04-18T12:00:00Z");
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Updated implementation.",
      },
      evidence: {
        issueCommentsCreated: 1,
        documentRevisionsCreated: 1,
        workProductsCreated: 1,
        toolOrActionEventsCreated: 1,
        latestEvidenceAt,
      },
    });

    expect(classification.livenessState).toBe("advanced");
    expect(classification.lastUsefulActionAt).toBe(latestEvidenceAt);
  });

  it("does not treat workspace operations alone as concrete progress", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "I will inspect the repo next.",
      },
      evidence: {
        workspaceOperationsCreated: 1,
        latestEvidenceAt: new Date("2026-04-18T12:00:00Z"),
      },
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.lastUsefulActionAt).toBeNull();
  });

  it("exempts planning/document tasks from plan-only retry classification", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issue: {
        status: "in_progress",
        title: "Draft implementation plan",
        description: "Create a plan for the work.",
      },
      resultJson: {
        summary: "Plan:\n- Inspect files\n- Implement after approval",
      },
    });

    expect(classification.livenessState).toBe("advanced");
  });

  it("exempts runs that update the plan document from plan-only classification", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Next steps:\n- inspect files\n- implement the service",
      },
      evidence: {
        documentRevisionsCreated: 1,
        planDocumentRevisionsCreated: 1,
        latestEvidenceAt: new Date("2026-04-18T12:00:00Z"),
      },
    });

    expect(classification.livenessState).toBe("advanced");
  });

  it("classifies done issues as completed", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issue: {
        ...baseInput.issue,
        status: "done",
      },
      resultJson: {
        summary: "Finished the implementation.",
      },
    });

    expect(classification.livenessState).toBe("completed");
  });

  it("classifies declared blockers as blocked", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "I cannot proceed because I need access credentials.",
      },
    });

    expect(classification.livenessState).toBe("blocked");
    expect(classification.actionability).toBe("blocked_external");
  });

  it("treats PAP-2000-style validation output as runnable follow-up, not an external blocker", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "PAP-1949 remains blocked until PAP-2000 is resolved.",
      },
      issueCommentBodies: [
        [
          "Validation is ready for the next pass.",
          "",
          "- Blocked chain context: PAP-1949 -> PAP-1999 -> PAP-2000",
          "- Next action: run npm test and report the row counts.",
        ].join("\n"),
      ],
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toBe("run npm test and report the row counts.");
  });

  it("prefers durable comments over raw transcript next-action noise", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issueCommentBodies: ["Next action: run pnpm test -- --runInBand."],
      stdoutExcerpt: [
        "tool_call: write",
        "command: rm -rf production-data",
        "Next action: deploy to production",
      ].join("\n"),
    });

    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toBe("run pnpm test -- --runInBand.");
  });

  it("keeps approval requests out of automatic continuation", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Next action: wait for board approval before continuing.",
      },
    });

    expect(classification.livenessState).toBe("blocked");
    expect(classification.actionability).toBe("approval_required");
    expect(classification.nextAction).toBe("wait for board approval before continuing.");
  });

  it("routes production-sensitive next actions to manager review", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Next action: deploy to production and verify live traffic.",
      },
    });

    expect(classification.livenessState).toBe("needs_followup");
    expect(classification.actionability).toBe("manager_review");
    expect(classification.nextAction).toBe("deploy to production and verify live traffic.");
  });


  it("uses killed background-task evidence instead of a generic failed-run reason", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      runStatus: "failed",
      errorCode: "process_lost",
      resultJson: {
        stopReason: "unmanaged_background_task_stopped",
        unmanagedBackgroundTask: {
          kind: "orphaned_process_group_cleanup",
          stopped: true,
          stopReason: "unmanaged_background_task_stopped",
          reason: "unmanaged background task stopped; no durable live path",
        },
      },
    });

    expect(classification.livenessState).toBe("failed");
    expect(classification.livenessReason).toBe("unmanaged background task stopped; no durable live path");
  });

  it("marks unclear useful output as unknown actionability", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Observed mixed output and left notes for a later pass.",
      },
    });

    expect(classification.livenessState).toBe("needs_followup");
    expect(classification.actionability).toBe("unknown");
    expect(classification.nextAction).toBeNull();
  });
});

describe("upstream throttled liveness", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");

  it("classifies a succeeded terminal 429 as transient upstream with a retry floor", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      stderrExcerpt: "429 RESOURCE_EXHAUSTED",
      now,
    });

    expect(classification.livenessState).toBe("upstream_throttled");
    expect(classification.errorFamily).toBe("transient_upstream");
    expect(classification.retryNotBefore).toBe(
      new Date(now.getTime() + DEFAULT_UPSTREAM_THROTTLED_RETRY_DELAY_MS).toISOString(),
    );
  });

  it("reuses a valid structured retry floor", () => {
    const retryNotBefore = "2026-08-04T12:09:00.000Z";
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: { retryNotBefore },
      stderrExcerpt: "status: 429 too many requests",
      now,
    });

    expect(classification.livenessState).toBe("upstream_throttled");
    expect(classification.retryNotBefore).toBe(retryNotBefore);
  });

  it("recognizes retryable AI_APICallError and 5xx terminal signatures", () => {
    for (const stderrExcerpt of [
      "AI_APICallError",
      "AI_APICallError: provider temporarily unavailable; try again",
      "HTTP status 503 Service Unavailable",
      "response status: 529",
    ]) {
      expect(classifyRunLiveness({ ...baseInput, stderrExcerpt, now }).livenessState).toBe(
        "upstream_throttled",
      );
    }
  });

  it("recognizes JSON-shaped retryable status errors", () => {
    expect(
      classifyRunLiveness({
        ...baseInput,
        resultJson: { error: { statusCode: 429, message: "Too many requests" } },
        now,
      }).livenessState,
    ).toBe("upstream_throttled");
    expect(
      classifyRunLiveness({
        ...baseInput,
        resultJson: { providerError: { responseStatus: 503 } },
        now,
      }).livenessState,
    ).toBe("upstream_throttled");
  });

  it("does not classify auth errors, benign numeric prose, or task-authored prose as throttles", () => {
    expect(
      classifyRunLiveness({
        ...baseInput,
        stderrExcerpt: "AI_APICallError: 401 Unauthorized; invalid API key",
        now,
      }).livenessState,
    ).toBe("needs_followup");
    expect(
      classifyRunLiveness({
        ...baseInput,
        stderrExcerpt: "status: processed 429 rows from the export",
        now,
      }).livenessState,
    ).toBe("empty_response");
    expect(
      classifyRunLiveness({
        ...baseInput,
        resultJson: { summary: "Documented HTTP status 503 as an example for the runbook." },
        now,
      }).livenessState,
    ).toBe("needs_followup");
  });

  it("preserves terminal issue, blocker, and useful-output decisions", () => {
    expect(
      classifyRunLiveness({
        ...baseInput,
        issue: { ...baseInput.issue, status: "done" },
        stderrExcerpt: "status: 429",
        now,
      }).livenessState,
    ).toBe("completed");
    expect(
      classifyRunLiveness({
        ...baseInput,
        issue: { ...baseInput.issue, status: "blocked" },
        stderrExcerpt: "status: 429",
        now,
      }).livenessState,
    ).toBe("blocked");
    expect(
      classifyRunLiveness({
        ...baseInput,
        resultJson: { summary: "Implemented and verified the requested change." },
        stderrExcerpt: "status: 429",
        now,
      }).livenessState,
    ).toBe("needs_followup");
  });

  it("parses provider retry delays and bounds the alarm exemption to the retry window", () => {
    expect(extractRetryableUpstreamRetryDelayMs('"retryDelay": "27s"')).toBe(27_000);
    expect(extractRetryableUpstreamRetryDelayMs("Retry-After: 60")).toBe(60_000);
    expect(extractRetryableUpstreamRetryDelayMs("Please try again in 1.5s.")).toBe(1_500);

    expect(
      isUpstreamThrottledBackoffPending({
        livenessState: "upstream_throttled",
        retryNotBefore: "2026-08-04T12:01:00.000Z",
        now,
      }),
    ).toBe(true);
    expect(
      isUpstreamThrottledBackoffPending({
        livenessState: "upstream_throttled",
        retryNotBefore: "2026-08-04T11:59:00.000Z",
        finishedAt: "2026-08-04T11:59:30.000Z",
        now,
      }),
    ).toBe(false);
  });
});

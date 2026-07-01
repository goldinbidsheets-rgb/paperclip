import { describe, expect, it } from "vitest";
import {
  classifyRunLiveness,
  extractRetryableUpstreamRetryDelayMs,
  isUpstreamThrottledBackoffPending,
  resolveUpstreamThrottledClassifierMode,
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

describe("upstream throttled classification (GOL-4038 Layer B)", () => {
  // Provider error payloads typically arrive as "status:"/"error:"-prefixed
  // lines, which the useful-output heuristic strips as transcript noise —
  // exactly why these runs historically landed in empty_response.
  const throttledStderr = [
    "status: 429",
    'payload: {"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for quota metric"}',
  ].join("\n");

  it("keeps legacy empty_response behavior when the caller does not opt in", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      stderrExcerpt: throttledStderr,
    });

    expect(classification.livenessState).toBe("empty_response");
    expect(classification.livenessReason).not.toContain("upstream");
  });

  it("classifies a succeeded 429/RESOURCE_EXHAUSTED run as upstream_throttled in enforce mode", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      stderrExcerpt: throttledStderr,
      upstreamThrottledMode: "enforce",
    });

    expect(classification.livenessState).toBe("upstream_throttled");
    expect(classification.livenessReason).toContain("retryable-upstream signature");
  });

  it("stays empty_response in shadow mode but records the would-be classification", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      stderrExcerpt: throttledStderr,
      upstreamThrottledMode: "shadow",
    });

    expect(classification.livenessState).toBe("empty_response");
    expect(classification.livenessReason).toContain("upstream-throttle shadow");
    expect(classification.livenessReason).toContain("upstream_throttled");
  });

  it("matches AI_APICallError and overloaded signatures in enforce mode", () => {
    for (const excerpt of [
      "stderr: AI_APICallError: rate limited by provider",
      'payload: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "status: 529",
    ]) {
      const classification = classifyRunLiveness({
        ...baseInput,
        stderrExcerpt: excerpt,
        upstreamThrottledMode: "enforce",
      });
      expect(classification.livenessState).toBe("upstream_throttled");
    }
  });

  it("does not throttle-classify when the run produced useful output", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: { summary: "Wrote the migration and updated the schema docs." },
      stderrExcerpt: throttledStderr,
      upstreamThrottledMode: "enforce",
    });

    expect(classification.livenessState).not.toBe("upstream_throttled");
  });

  it("does not match a bare numeric 429 outside an HTTP/status context", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      stderrExcerpt: "stdout: processed 429 rows from the batch export",
      upstreamThrottledMode: "enforce",
    });

    expect(classification.livenessState).toBe("empty_response");
  });

  it("resolves the classifier mode from env with a shadow default", () => {
    expect(resolveUpstreamThrottledClassifierMode({})).toBe("shadow");
    expect(
      resolveUpstreamThrottledClassifierMode({ PAPERCLIP_UPSTREAM_THROTTLED_CLASSIFIER_MODE: "enforce" }),
    ).toBe("enforce");
    expect(
      resolveUpstreamThrottledClassifierMode({ PAPERCLIP_UPSTREAM_THROTTLED_CLASSIFIER_MODE: "OFF" }),
    ).toBe("off");
    expect(
      resolveUpstreamThrottledClassifierMode({ PAPERCLIP_UPSTREAM_THROTTLED_CLASSIFIER_MODE: "bogus" }),
    ).toBe("shadow");
  });

  it("extracts an explicit retry delay when the provider offers one", () => {
    expect(extractRetryableUpstreamRetryDelayMs('"retryDelay": "27s"')).toBe(27_000);
    expect(extractRetryableUpstreamRetryDelayMs("Retry-After: 60")).toBe(60_000);
    expect(extractRetryableUpstreamRetryDelayMs("Please try again in 1.5s.")).toBe(1_500);
    expect(extractRetryableUpstreamRetryDelayMs('"retryDelay": "86400s"')).toBe(15 * 60 * 1000);
    expect(extractRetryableUpstreamRetryDelayMs("no delay hints here")).toBeNull();
    expect(extractRetryableUpstreamRetryDelayMs(null)).toBeNull();
  });

  it("treats the backoff window as pending only while it is open", () => {
    const now = new Date("2026-07-01T12:00:00Z");
    expect(
      isUpstreamThrottledBackoffPending({
        livenessState: "upstream_throttled",
        retryNotBefore: "2026-07-01T12:05:00Z",
        now,
      }),
    ).toBe(true);
    expect(
      isUpstreamThrottledBackoffPending({
        livenessState: "upstream_throttled",
        retryNotBefore: "2026-07-01T11:55:00Z",
        finishedAt: "2026-07-01T10:00:00Z",
        now,
      }),
    ).toBe(false);
    expect(
      isUpstreamThrottledBackoffPending({
        livenessState: "upstream_throttled",
        finishedAt: "2026-07-01T11:45:00Z",
        now,
      }),
    ).toBe(true);
    expect(
      isUpstreamThrottledBackoffPending({
        livenessState: "empty_response",
        retryNotBefore: "2026-07-01T12:05:00Z",
        now,
      }),
    ).toBe(false);
  });
});

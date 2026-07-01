import { describe, expect, it } from "vitest";
import {
  DEFAULT_ISSUE_UPSTREAM_THROTTLE_CEILING,
  DEFAULT_ISSUE_UPSTREAM_THROTTLE_WINDOW_MS,
  DEFAULT_LIVENESS_CONTINUATION_BACKOFF_BASE_MS,
  DEFAULT_LIVENESS_CONTINUATION_BACKOFF_CAP_MS,
  buildIssueThrottleCeilingIdempotencyKey,
  buildIssueThrottleCeilingNotice,
  computeLivenessContinuationBackoff,
  decideIssueThrottleCeiling,
  readRunThrottleExitKind,
  resolveLivenessContinuationBackoffConfig,
  summarizeIssueThrottleExits,
} from "./liveness-continuation-throttle.js";

const now = new Date("2026-07-01T12:00:00.000Z");

function minutesAgo(minutes: number) {
  return new Date(now.getTime() - minutes * 60_000);
}

function throttleRun(overrides: Record<string, unknown> = {}) {
  return {
    status: "failed",
    errorCode: null,
    resultJson: { errorFamily: "transient_upstream" },
    livenessState: null,
    finishedAt: minutesAgo(1),
    ...overrides,
  };
}

describe("resolveLivenessContinuationBackoffConfig", () => {
  it("defaults to shadow mode with documented defaults", () => {
    const config = resolveLivenessContinuationBackoffConfig({});
    expect(config).toEqual({
      mode: "shadow",
      backoffBaseMs: DEFAULT_LIVENESS_CONTINUATION_BACKOFF_BASE_MS,
      backoffCapMs: DEFAULT_LIVENESS_CONTINUATION_BACKOFF_CAP_MS,
      throttleWindowMs: DEFAULT_ISSUE_UPSTREAM_THROTTLE_WINDOW_MS,
      throttleCeiling: DEFAULT_ISSUE_UPSTREAM_THROTTLE_CEILING,
    });
  });

  it("parses explicit modes and falls back to shadow on garbage", () => {
    expect(resolveLivenessContinuationBackoffConfig({ LIVENESS_CONTINUATION_BACKOFF_MODE: "off" }).mode).toBe("off");
    expect(resolveLivenessContinuationBackoffConfig({ LIVENESS_CONTINUATION_BACKOFF_MODE: "ENFORCE" }).mode).toBe(
      "enforce",
    );
    expect(resolveLivenessContinuationBackoffConfig({ LIVENESS_CONTINUATION_BACKOFF_MODE: "banana" }).mode).toBe(
      "shadow",
    );
  });

  it("clamps the cap to at least the base and rejects non-positive overrides", () => {
    const config = resolveLivenessContinuationBackoffConfig({
      LIVENESS_CONTINUATION_BACKOFF_BASE_MS: "120000",
      LIVENESS_CONTINUATION_BACKOFF_CAP_MS: "1000",
      ISSUE_UPSTREAM_THROTTLE_CEILING: "-3",
    });
    expect(config.backoffBaseMs).toBe(120_000);
    expect(config.backoffCapMs).toBe(120_000);
    expect(config.throttleCeiling).toBe(DEFAULT_ISSUE_UPSTREAM_THROTTLE_CEILING);
  });
});

describe("computeLivenessContinuationBackoff", () => {
  const config = { backoffBaseMs: 60_000, backoffCapMs: 900_000 };

  it("doubles per attempt starting at the base delay", () => {
    expect(computeLivenessContinuationBackoff(1, config, now).delayMs).toBe(60_000);
    expect(computeLivenessContinuationBackoff(2, config, now).delayMs).toBe(120_000);
    expect(computeLivenessContinuationBackoff(3, config, now).delayMs).toBe(240_000);
  });

  it("caps the delay and anchors notBefore to now", () => {
    const backoff = computeLivenessContinuationBackoff(10, config, now);
    expect(backoff.delayMs).toBe(900_000);
    expect(backoff.notBefore.getTime()).toBe(now.getTime() + 900_000);
  });

  it("treats invalid attempts as the first attempt", () => {
    expect(computeLivenessContinuationBackoff(0, config, now).delayMs).toBe(60_000);
    expect(computeLivenessContinuationBackoff(Number.NaN, config, now).delayMs).toBe(60_000);
  });
});

describe("readRunThrottleExitKind", () => {
  it("classifies the transient_upstream error family and adapter error codes", () => {
    expect(readRunThrottleExitKind(throttleRun())).toBe("transient_upstream");
    expect(
      readRunThrottleExitKind({ status: "failed", errorCode: "codex_transient_upstream", resultJson: null }),
    ).toBe("transient_upstream");
    expect(
      readRunThrottleExitKind({ status: "failed", errorCode: "claude_transient_upstream", resultJson: null }),
    ).toBe("transient_upstream");
  });

  it("classifies the upstream_throttled liveness state from clean exits", () => {
    expect(
      readRunThrottleExitKind({ status: "succeeded", livenessState: "upstream_throttled", resultJson: {} }),
    ).toBe("upstream_throttled");
  });

  it("returns null for ordinary runs", () => {
    expect(readRunThrottleExitKind({ status: "succeeded", livenessState: "advanced", resultJson: {} })).toBeNull();
    expect(readRunThrottleExitKind({ status: "failed", errorCode: "process_lost", resultJson: {} })).toBeNull();
    expect(readRunThrottleExitKind({ status: "succeeded", resultJson: { errorFamily: "other" } })).toBeNull();
  });
});

describe("summarizeIssueThrottleExits", () => {
  const windowMs = 60 * 60_000;

  it("counts consecutive throttle exits newest-first", () => {
    const summary = summarizeIssueThrottleExits(
      [
        throttleRun({ finishedAt: minutesAgo(1) }),
        throttleRun({ finishedAt: minutesAgo(5), livenessState: "upstream_throttled", resultJson: {}, status: "succeeded" }),
        throttleRun({ finishedAt: minutesAgo(9) }),
      ],
      { now, windowMs },
    );
    expect(summary.consecutive).toBe(3);
    expect(summary.kinds).toEqual(["transient_upstream", "upstream_throttled", "transient_upstream"]);
    expect(summary.lastExitAt?.getTime()).toBe(minutesAgo(1).getTime());
    expect(summary.firstExitAt?.getTime()).toBe(minutesAgo(9).getTime());
  });

  it("breaks the streak on a productive terminal run", () => {
    const summary = summarizeIssueThrottleExits(
      [
        throttleRun({ finishedAt: minutesAgo(1) }),
        { status: "succeeded", resultJson: {}, livenessState: "advanced", finishedAt: minutesAgo(3) },
        throttleRun({ finishedAt: minutesAgo(5) }),
        throttleRun({ finishedAt: minutesAgo(7) }),
      ],
      { now, windowMs },
    );
    expect(summary.consecutive).toBe(1);
  });

  it("ignores exits older than the rolling window", () => {
    const summary = summarizeIssueThrottleExits(
      [throttleRun({ finishedAt: minutesAgo(1) }), throttleRun({ finishedAt: minutesAgo(90) })],
      { now, windowMs },
    );
    expect(summary.consecutive).toBe(1);
  });

  it("tolerates unsorted input and non-terminal rows", () => {
    const summary = summarizeIssueThrottleExits(
      [
        throttleRun({ finishedAt: minutesAgo(9) }),
        { status: "running", finishedAt: null },
        throttleRun({ finishedAt: minutesAgo(1) }),
      ],
      { now, windowMs },
    );
    expect(summary.consecutive).toBe(2);
  });

  it("replays the 9-exit retry storm as one saturated streak", () => {
    const storm = Array.from({ length: 9 }, (_, index) => throttleRun({ finishedAt: minutesAgo(index * 4 + 1) }));
    const summary = summarizeIssueThrottleExits(storm, { now, windowMs });
    expect(summary.consecutive).toBe(9);
    // The burst key stays anchored to the first exit, so the consolidated
    // notice fires once for the storm instead of once per exit.
    expect(summary.firstExitAt?.getTime()).toBe(minutesAgo(33).getTime());
  });
});

describe("decideIssueThrottleCeiling", () => {
  const config = { throttleCeiling: 3, throttleWindowMs: 60 * 60_000 };

  it("trips at the ceiling and not below it", () => {
    const below = summarizeIssueThrottleExits(
      [throttleRun({ finishedAt: minutesAgo(1) }), throttleRun({ finishedAt: minutesAgo(2) })],
      { now, windowMs: config.throttleWindowMs },
    );
    expect(decideIssueThrottleCeiling(below, config).tripped).toBe(false);

    const at = summarizeIssueThrottleExits(
      [1, 2, 3].map((minute) => throttleRun({ finishedAt: minutesAgo(minute) })),
      { now, windowMs: config.throttleWindowMs },
    );
    expect(decideIssueThrottleCeiling(at, config)).toEqual({
      tripped: true,
      consecutive: 3,
      ceiling: 3,
      windowMs: config.throttleWindowMs,
    });
  });
});

describe("consolidated notice", () => {
  it("builds a stable per-burst idempotency key", () => {
    const key = buildIssueThrottleCeilingIdempotencyKey({
      issueId: "issue-1",
      firstExitAt: minutesAgo(9),
    });
    expect(key).toBe(`issue-upstream-throttle-ceiling:issue-1:${minutesAgo(9).toISOString()}`);
  });

  it("names the real blocker and embeds the idempotency key", () => {
    const notice = buildIssueThrottleCeilingNotice({
      issueIdentifier: "PAP-42",
      consecutive: 3,
      ceiling: 3,
      windowMs: 60 * 60_000,
      kinds: ["transient_upstream", "transient_upstream", "upstream_throttled"],
      idempotencyKey: "issue-upstream-throttle-ceiling:issue-1:2026-07-01T11:51:00.000Z",
    });
    expect(notice).toContain("Upstream throttle ceiling reached");
    expect(notice).toContain("quota / rate-limiting");
    expect(notice).toContain("transient_upstream ×2");
    expect(notice).toContain("upstream_throttled ×1");
    expect(notice).toContain("PAP-42");
    expect(notice).toContain("issue-upstream-throttle-ceiling:issue-1:2026-07-01T11:51:00.000Z");
  });
});

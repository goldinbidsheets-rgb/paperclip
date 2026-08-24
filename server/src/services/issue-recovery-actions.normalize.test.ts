import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_state",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("normalizeExhaustedMissingDispositionActions", () => {
  it("normalizes a pre-existing capped active row without changing issue status", async () => {
    const legacyRow = makeRecoveryActionRow({
      id: "legacy-capped-action",
      status: "active",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      previousOwnerAgentId: "agent-1",
      maxAttempts: 1,
      evidence: {
        handoffAttempt: 1,
        maxHandoffAttempts: 1,
      },
      wakePolicy: {
        type: "wake_owner",
        reason: "source_scoped_recovery_action",
        ownerAgentId: "agent-1",
      },
    });
    let persisted: Record<string, unknown> | null = null;
    const fakeDb = {
      select: vi.fn(() => ({
        from() {
          return this;
        },
        where() {
          return Promise.resolve([legacyRow]);
        },
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          persisted = values;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: legacyRow.id }]),
            })),
          };
        }),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never)
      .normalizeExhaustedMissingDispositionActions();

    expect(result).toEqual({
      scanned: 1,
      normalized: 1,
      actionIds: [legacyRow.id],
    });
    expect(persisted).toMatchObject({
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: "agent-1",
      wakePolicy: {
        type: "board_escalation",
        reason: "successful_run_handoff_exhausted",
      },
      evidence: expect.objectContaining({
        exhausted: true,
        handoffAttempt: 1,
        maxHandoffAttempts: 1,
      }),
    });
    expect(persisted).not.toHaveProperty("sourceIssueId");
    expect(Object.keys(persisted ?? {})).not.toContain("issueStatus");
  });

  it("leaves already honest exhausted rows and live uncapped rows untouched", async () => {
    const honestRow = makeRecoveryActionRow({
      id: "honest-escalated",
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      evidence: { handoffAttempt: 1, maxHandoffAttempts: 1, exhausted: true },
      wakePolicy: { type: "board_escalation", reason: "successful_run_handoff_exhausted" },
    });
    const liveRow = makeRecoveryActionRow({
      id: "live-uncapped",
      status: "active",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      evidence: { handoffAttempt: 1, maxHandoffAttempts: 2 },
      wakePolicy: { type: "wake_owner" },
    });
    const fakeDb = {
      select: vi.fn(() => ({
        from() {
          return this;
        },
        where() {
          return Promise.resolve([honestRow, liveRow]);
        },
      })),
      update: vi.fn(),
    };

    const result = await issueRecoveryActionService(fakeDb as never)
      .normalizeExhaustedMissingDispositionActions();

    expect(result).toEqual({ scanned: 2, normalized: 0, actionIds: [] });
    expect(fakeDb.update).not.toHaveBeenCalled();
  });
});

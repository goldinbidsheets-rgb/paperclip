import { describe, expect, it, vi } from "vitest";
import {
  findWindowsProcessTreeEvidence,
  parseWindowsProcessSnapshot,
  probeWindowsProcessTreeLiveness,
  type WindowsProcessSnapshotEntry,
} from "./windows-process-tree.js";

const rootStartedAt = new Date("2026-08-05T11:59:21.000Z");

function entry(
  pid: number,
  parentPid: number,
  name: string,
  startedAt = "2026-08-05T11:59:22.000Z",
): WindowsProcessSnapshotEntry {
  return { pid, parentPid, name, startedAt };
}

describe("Windows process tree liveness", () => {
  it("parses the bounded process identity fields without command lines", () => {
    const parsed = parseWindowsProcessSnapshot([
      "24001\t23772\t2026-08-05T11:59:22.0000000Z\tnode.exe",
      "not-a-pid\t23772\t2026-08-05T11:59:22.0000000Z\tignored.exe",
      "24002\t23772\tnot-a-date\tignored.exe",
      "",
    ].join("\r\n"));

    expect(parsed).toEqual([
      {
        pid: 24001,
        parentPid: 23772,
        startedAt: "2026-08-05T11:59:22.0000000Z",
        name: "node.exe",
      },
    ]);
  });

  it("finds a live agent descendant even after the recorded wrapper disappeared", () => {
    const evidence = findWindowsProcessTreeEvidence(
      [
        entry(24000, 23772, "cmd.exe"),
        entry(24001, 23772, "node.exe"),
        entry(24002, 24001, "worker.exe"),
      ],
      { runId: "run-1", pid: 23772, startedAt: rootStartedAt },
      new Date("2026-08-05T12:02:05.000Z"),
    );

    expect(evidence).toMatchObject({
      rootPid: 23772,
      rootStartedAt: rootStartedAt.toISOString(),
      observedAt: "2026-08-05T12:02:05.000Z",
    });
    expect(evidence?.descendants.map((process) => process.pid)).toEqual([24000, 24001, 24002]);
    expect(evidence?.agentDescendants.map((process) => process.pid)).toEqual([24001, 24002]);
  });

  it("rejects wrapper-only and PID-reuse process trees", () => {
    const wrapperOnly = findWindowsProcessTreeEvidence(
      [entry(24000, 23772, "powershell.exe")],
      { runId: "run-1", pid: 23772, startedAt: rootStartedAt },
    );
    const reusedPidTree = findWindowsProcessTreeEvidence(
      [entry(25000, 23772, "node.exe", "2026-08-05T12:10:00.000Z")],
      { runId: "run-1", pid: 23772, startedAt: rootStartedAt },
    );

    expect(wrapperOnly).toBeNull();
    expect(reusedPidTree).toBeNull();
  });

  it("uses a bounded retry window and returns only roots with positive evidence", async () => {
    const readSnapshot = vi
      .fn<() => Promise<WindowsProcessSnapshotEntry[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([entry(24001, 23772, "node.exe")]);
    const sleep = vi.fn(async () => undefined);

    const evidence = await probeWindowsProcessTreeLiveness(
      [{ runId: "run-1", pid: 23772, startedAt: rootStartedAt }],
      {
        attempts: 3,
        intervalMs: 250,
        readSnapshot,
        sleep,
        now: () => new Date("2026-08-05T12:02:05.000Z"),
      },
    );

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(evidence.get("run-1")?.agentDescendants).toEqual([
      entry(24001, 23772, "node.exe"),
    ]);
  });
});

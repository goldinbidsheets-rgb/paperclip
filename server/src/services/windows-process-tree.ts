import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const PROCESS_START_CLOCK_SKEW_MS = 5_000;
const PROCESS_SPAWN_WINDOW_MS = 60_000;
const DEFAULT_PROBE_ATTEMPTS = 3;
const DEFAULT_PROBE_INTERVAL_MS = 250;

const WINDOWS_WRAPPER_PROCESS_NAMES = new Set([
  "cmd.exe",
  "conhost.exe",
  "findstr.exe",
  "more.com",
  "powershell.exe",
  "pwsh.exe",
  "tee.exe",
  "timeout.exe",
]);

export type WindowsProcessSnapshotEntry = {
  pid: number;
  parentPid: number;
  startedAt: string;
  name: string;
};

export type WindowsProcessTreeRoot = {
  runId: string;
  pid: number;
  startedAt: Date;
};

export type WindowsProcessTreeEvidence = {
  rootPid: number;
  rootStartedAt: string;
  observedAt: string;
  descendants: WindowsProcessSnapshotEntry[];
  agentDescendants: WindowsProcessSnapshotEntry[];
};

export type WindowsProcessTreeProbe = (
  roots: WindowsProcessTreeRoot[],
) => Promise<Map<string, WindowsProcessTreeEvidence>>;

function parsePositiveInteger(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseWindowsProcessSnapshot(raw: string): WindowsProcessSnapshotEntry[] {
  const entries: WindowsProcessSnapshotEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [pidRaw, parentPidRaw, startedAtRaw, ...nameParts] = line.split("\t");
    const pid = parsePositiveInteger(pidRaw ?? "");
    const parentPid = parsePositiveInteger(parentPidRaw ?? "");
    const startedAt = startedAtRaw?.trim() ?? "";
    const name = nameParts.join("\t").trim();
    if (!pid || !parentPid || !name || !Number.isFinite(Date.parse(startedAt))) continue;
    entries.push({ pid, parentPid, startedAt, name });
  }
  return entries;
}

export function findWindowsProcessTreeEvidence(
  snapshot: WindowsProcessSnapshotEntry[],
  root: WindowsProcessTreeRoot,
  observedAt = new Date(),
): WindowsProcessTreeEvidence | null {
  const rootStartedAtMs = root.startedAt.getTime();
  if (!Number.isFinite(rootStartedAtMs)) return null;

  const earliestStartedAt = rootStartedAtMs - PROCESS_START_CLOCK_SKEW_MS;
  const latestStartedAt = rootStartedAtMs + PROCESS_SPAWN_WINDOW_MS;
  const childrenByParent = new Map<number, WindowsProcessSnapshotEntry[]>();
  for (const entry of snapshot) {
    const startedAtMs = Date.parse(entry.startedAt);
    if (startedAtMs < earliestStartedAt || startedAtMs > latestStartedAt) continue;
    const children = childrenByParent.get(entry.parentPid) ?? [];
    children.push(entry);
    childrenByParent.set(entry.parentPid, children);
  }

  const descendants: WindowsProcessSnapshotEntry[] = [];
  const pending = [...(childrenByParent.get(root.pid) ?? [])];
  const visited = new Set<number>([root.pid]);
  while (pending.length > 0) {
    const entry = pending.shift()!;
    if (visited.has(entry.pid)) continue;
    visited.add(entry.pid);
    descendants.push(entry);
    pending.push(...(childrenByParent.get(entry.pid) ?? []));
  }

  descendants.sort((left, right) => left.pid - right.pid);
  const agentDescendants = descendants.filter(
    (entry) => !WINDOWS_WRAPPER_PROCESS_NAMES.has(entry.name.trim().toLowerCase()),
  );
  if (agentDescendants.length === 0) return null;

  return {
    rootPid: root.pid,
    rootStartedAt: root.startedAt.toISOString(),
    observedAt: observedAt.toISOString(),
    descendants,
    agentDescendants,
  };
}

async function readWindowsProcessSnapshot(): Promise<WindowsProcessSnapshotEntry[]> {
  if (process.platform !== "win32") return [];

  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "  $created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }",
    "  \"$($_.ProcessId)`t$($_.ParentProcessId)`t$created`t$($_.Name)\"",
    "}",
  ].join("\n");
  const { stdout } = await execFile(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  return parseWindowsProcessSnapshot(String(stdout));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function probeWindowsProcessTreeLiveness(
  roots: WindowsProcessTreeRoot[],
  options: {
    attempts?: number;
    intervalMs?: number;
    readSnapshot?: () => Promise<WindowsProcessSnapshotEntry[]>;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => Date;
  } = {},
): Promise<Map<string, WindowsProcessTreeEvidence>> {
  const remaining = new Map(roots.map((root) => [root.runId, root]));
  const evidence = new Map<string, WindowsProcessTreeEvidence>();
  if (remaining.size === 0) return evidence;
  if (process.platform !== "win32" && !options.readSnapshot) return evidence;

  const attempts = Math.max(1, options.attempts ?? DEFAULT_PROBE_ATTEMPTS);
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS);
  const readSnapshot = options.readSnapshot ?? readWindowsProcessSnapshot;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? (() => new Date());

  for (let attempt = 0; attempt < attempts && remaining.size > 0; attempt += 1) {
    const snapshot = await readSnapshot();
    const observedAt = now();
    for (const [runId, root] of remaining) {
      const found = findWindowsProcessTreeEvidence(snapshot, root, observedAt);
      if (!found) continue;
      evidence.set(runId, found);
      remaining.delete(runId);
    }
    if (attempt + 1 < attempts && remaining.size > 0) await sleep(intervalMs);
  }

  return evidence;
}

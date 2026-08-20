import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export const HOST_CAPACITY_BLOCK_ERROR_CODE = "host_capacity_preflight_blocked";
export const HOST_CAPACITY_MIN_FREE_BYTES_ENV = "PAPERCLIP_RUN_MIN_FREE_BYTES";
export const HOST_CAPACITY_PATH_ENV = "PAPERCLIP_RUN_CAPACITY_PATH";

export type HostCapacityBlockReason = "below_floor" | "invalid_configuration" | "measurement_failed";

export type HostCapacityPreflightDecision =
  | {
      enabled: false;
      allowed: true;
    }
  | {
      enabled: true;
      allowed: true;
      freeBytes: bigint;
      minimumFreeBytes: bigint;
    }
  | {
      enabled: true;
      allowed: false;
      reason: HostCapacityBlockReason;
      freeBytes: bigint | null;
      minimumFreeBytes: bigint | null;
    };

type StatFsResult = {
  bavail: bigint;
  bsize: bigint;
};

export interface HostCapacityPreflightOptions {
  env?: NodeJS.ProcessEnv;
  instanceRoot?: string;
  statfs?: (targetPath: string) => Promise<StatFsResult>;
}

function parseMinimumFreeBytes(raw: string | undefined) {
  const normalized = raw?.trim();
  if (!normalized) return { kind: "disabled" as const };
  if (!/^[0-9]+$/.test(normalized)) return { kind: "invalid" as const };
  try {
    const value = BigInt(normalized);
    return value > 0n
      ? { kind: "configured" as const, value }
      : { kind: "invalid" as const };
  } catch {
    return { kind: "invalid" as const };
  }
}

async function statfsAvailableBytes(targetPath: string): Promise<StatFsResult> {
  const result = await fs.statfs(targetPath, { bigint: true });
  return { bavail: result.bavail, bsize: result.bsize };
}

/**
 * Measure the volume that owns the Paperclip instance before a queued run is
 * claimed. An unset floor preserves the historical behavior. Once configured,
 * malformed configuration and measurement failures both fail closed.
 */
export async function evaluateHostCapacityPreflight(
  options: HostCapacityPreflightOptions = {},
): Promise<HostCapacityPreflightDecision> {
  const env = options.env ?? process.env;
  const minimum = parseMinimumFreeBytes(env[HOST_CAPACITY_MIN_FREE_BYTES_ENV]);
  if (minimum.kind === "disabled") return { enabled: false, allowed: true };
  if (minimum.kind === "invalid") {
    return {
      enabled: true,
      allowed: false,
      reason: "invalid_configuration",
      freeBytes: null,
      minimumFreeBytes: null,
    };
  }

  const instanceRoot = options.instanceRoot ?? resolvePaperclipInstanceRoot();
  const configuredPath = env[HOST_CAPACITY_PATH_ENV]?.trim();
  const targetPath = path.resolve(configuredPath || instanceRoot);
  const statfs = options.statfs ?? statfsAvailableBytes;
  try {
    const measured = await statfs(targetPath);
    if (measured.bavail < 0n || measured.bsize <= 0n) throw new Error("invalid statfs result");
    const freeBytes = measured.bavail * measured.bsize;
    if (freeBytes < minimum.value) {
      return {
        enabled: true,
        allowed: false,
        reason: "below_floor",
        freeBytes,
        minimumFreeBytes: minimum.value,
      };
    }
    return {
      enabled: true,
      allowed: true,
      freeBytes,
      minimumFreeBytes: minimum.value,
    };
  } catch {
    return {
      enabled: true,
      allowed: false,
      reason: "measurement_failed",
      freeBytes: null,
      minimumFreeBytes: minimum.value,
    };
  }
}

export function hostCapacityDecisionPayload(
  decision: Exclude<HostCapacityPreflightDecision, { enabled: false }>,
) {
  return {
    version: 1,
    reason: decision.allowed ? "allowed" : decision.reason,
    freeBytes: decision.freeBytes?.toString() ?? null,
    minimumFreeBytes: decision.minimumFreeBytes?.toString() ?? null,
  };
}

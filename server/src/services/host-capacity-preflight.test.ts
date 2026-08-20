import { describe, expect, it, vi } from "vitest";
import {
  evaluateHostCapacityPreflight,
  hostCapacityDecisionPayload,
  HOST_CAPACITY_MIN_FREE_BYTES_ENV,
} from "./host-capacity-preflight.js";

describe("host capacity preflight", () => {
  it("preserves historical behavior when no floor is configured", async () => {
    const statfs = vi.fn();
    await expect(evaluateHostCapacityPreflight({ env: {}, statfs })).resolves.toEqual({
      enabled: false,
      allowed: true,
    });
    expect(statfs).not.toHaveBeenCalled();
  });

  it("blocks below the configured floor with an exact byte measurement", async () => {
    const decision = await evaluateHostCapacityPreflight({
      env: { [HOST_CAPACITY_MIN_FREE_BYTES_ENV]: "100" },
      statfs: async () => ({ bavail: 9n, bsize: 10n }),
    });
    expect(decision).toEqual({
      enabled: true,
      allowed: false,
      reason: "below_floor",
      freeBytes: 90n,
      minimumFreeBytes: 100n,
    });
    if (decision.enabled) {
      expect(hostCapacityDecisionPayload(decision)).toEqual({
        version: 1,
        reason: "below_floor",
        freeBytes: "90",
        minimumFreeBytes: "100",
      });
    }
  });

  it("allows equality at the configured floor", async () => {
    await expect(evaluateHostCapacityPreflight({
      env: { [HOST_CAPACITY_MIN_FREE_BYTES_ENV]: "100" },
      statfs: async () => ({ bavail: 10n, bsize: 10n }),
    })).resolves.toEqual({
      enabled: true,
      allowed: true,
      freeBytes: 100n,
      minimumFreeBytes: 100n,
    });
  });

  it("fails closed on invalid configuration and measurement failure", async () => {
    await expect(evaluateHostCapacityPreflight({
      env: { [HOST_CAPACITY_MIN_FREE_BYTES_ENV]: "64GiB" },
    })).resolves.toMatchObject({
      enabled: true,
      allowed: false,
      reason: "invalid_configuration",
    });

    await expect(evaluateHostCapacityPreflight({
      env: { [HOST_CAPACITY_MIN_FREE_BYTES_ENV]: "100" },
      statfs: async () => {
        throw new Error("probe failed");
      },
    })).resolves.toEqual({
      enabled: true,
      allowed: false,
      reason: "measurement_failed",
      freeBytes: null,
      minimumFreeBytes: 100n,
    });
  });
});

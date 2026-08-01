import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_AGNOSTIC_KEYS,
  isAdapterConfigKeyPreservedAcrossAdapterTypes,
} from "./constants.js";

const EXPECTED_ADAPTER_AGNOSTIC_KEYS = [
  "env",
  "promptTemplate",
  "instructionsFilePath",
  "cwd",
  "timeoutSec",
  "graceSec",
  "bootstrapPromptTemplate",
  "paperclipSkillSync",
] as const;

function readRepoFile(pathFromRoot: string) {
  return readFileSync(
    fileURLToPath(new URL(`../../../${pathFromRoot}`, import.meta.url)),
    "utf8",
  );
}

describe("adapter-agnostic config keys", () => {
  it("keeps the preserved adapter config keys explicit", () => {
    expect(ADAPTER_AGNOSTIC_KEYS).toEqual(EXPECTED_ADAPTER_AGNOSTIC_KEYS);
  });

  it("also preserves the dynamic access-grant namespace", () => {
    for (const key of EXPECTED_ADAPTER_AGNOSTIC_KEYS) {
      expect(isAdapterConfigKeyPreservedAcrossAdapterTypes(key)).toBe(true);
    }
    expect(isAdapterConfigKeyPreservedAcrossAdapterTypes("access.CRM_READ")).toBe(true);
    expect(isAdapterConfigKeyPreservedAcrossAdapterTypes("access.INVENTORY_WRITE")).toBe(true);
    expect(isAdapterConfigKeyPreservedAcrossAdapterTypes("model")).toBe(false);
    expect(isAdapterConfigKeyPreservedAcrossAdapterTypes("command")).toBe(false);
  });

  it("is imported by the server and UI instead of being re-declared", () => {
    const serverSource = readRepoFile("server/src/routes/agents.ts");
    const uiSource = readRepoFile("ui/src/lib/agent-config-patch.ts");

    expect(serverSource).toContain("isAdapterConfigKeyPreservedAcrossAdapterTypes");
    expect(serverSource).toContain("from \"@paperclipai/shared\"");
    expect(serverSource).not.toMatch(/const\s+ADAPTER_AGNOSTIC_KEYS\s*=/);

    expect(uiSource).toContain("isAdapterConfigKeyPreservedAcrossAdapterTypes");
    expect(uiSource).toContain("from \"@paperclipai/shared\"");
    expect(uiSource).not.toMatch(/const\s+ADAPTER_AGNOSTIC_KEYS\s*=/);
  });
});

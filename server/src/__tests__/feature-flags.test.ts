// Interim feature-flag helper tests (fork-patch). Upstream RFC:
// https://github.com/paperclipai/paperclip/issues/3960

import { afterEach, describe, expect, it } from "vitest";
import { isAgentMemoryTabEnabled } from "../feature-flags.js";

const ORIGINAL = process.env.PAPERCLIP_FEATURE_AGENT_MEMORY_TAB;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PAPERCLIP_FEATURE_AGENT_MEMORY_TAB;
  else process.env.PAPERCLIP_FEATURE_AGENT_MEMORY_TAB = ORIGINAL;
});

describe("isAgentMemoryTabEnabled", () => {
  it("defaults to false when unset", () => {
    delete process.env.PAPERCLIP_FEATURE_AGENT_MEMORY_TAB;
    expect(isAgentMemoryTabEnabled()).toBe(false);
  });

  it("treats 'true', '1', 'yes', 'on' as enabled (case-insensitive)", () => {
    for (const value of ["true", "TRUE", "1", "yes", "on", "True"]) {
      process.env.PAPERCLIP_FEATURE_AGENT_MEMORY_TAB = value;
      expect(isAgentMemoryTabEnabled()).toBe(true);
    }
  });

  it("treats other values as disabled", () => {
    for (const value of ["", "false", "0", "no", "off", "maybe"]) {
      process.env.PAPERCLIP_FEATURE_AGENT_MEMORY_TAB = value;
      expect(isAgentMemoryTabEnabled()).toBe(false);
    }
  });
});

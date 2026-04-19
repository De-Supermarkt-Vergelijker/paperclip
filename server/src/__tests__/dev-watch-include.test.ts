import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveServerDevWatchIncludeGlobs } from "../dev-watch-include.js";

function toForwardSlash(candidate: string): string {
  return candidate.replaceAll(path.sep, "/");
}

describe("resolveServerDevWatchIncludeGlobs", () => {
  it("returns globs for server src/scripts and every workspace package src directory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-watch-include-"));
    const monorepoRoot = path.join(tempRoot, "repo");
    const serverRoot = path.join(monorepoRoot, "server");

    fs.mkdirSync(path.join(serverRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(serverRoot, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(monorepoRoot, "packages", "shared", "src"), { recursive: true });
    fs.mkdirSync(path.join(monorepoRoot, "packages", "db", "src"), { recursive: true });
    fs.mkdirSync(path.join(monorepoRoot, "packages", "no-src"), { recursive: true });
    fs.mkdirSync(path.join(monorepoRoot, "packages", "adapters", "claude-local", "src"), { recursive: true });
    fs.mkdirSync(path.join(monorepoRoot, "packages", "plugins", "core", "src"), { recursive: true });
    fs.mkdirSync(path.join(monorepoRoot, "packages", "plugins", "examples", "hello", "src"), { recursive: true });
    fs.mkdirSync(path.join(monorepoRoot, "cli", "src"), { recursive: true });

    const globs = resolveServerDevWatchIncludeGlobs(serverRoot);

    const extSuffix = "/**/*.{ts,tsx,mts,cts,js,mjs,cjs,json}";
    const expected = [
      `${toForwardSlash(path.join(serverRoot, "src"))}${extSuffix}`,
      `${toForwardSlash(path.join(serverRoot, "scripts"))}${extSuffix}`,
      `${toForwardSlash(path.join(monorepoRoot, "packages", "shared", "src"))}${extSuffix}`,
      `${toForwardSlash(path.join(monorepoRoot, "packages", "db", "src"))}${extSuffix}`,
      `${toForwardSlash(path.join(monorepoRoot, "packages", "adapters", "claude-local", "src"))}${extSuffix}`,
      `${toForwardSlash(path.join(monorepoRoot, "packages", "plugins", "core", "src"))}${extSuffix}`,
      `${toForwardSlash(path.join(monorepoRoot, "packages", "plugins", "examples", "hello", "src"))}${extSuffix}`,
      `${toForwardSlash(path.join(monorepoRoot, "cli", "src"))}${extSuffix}`,
    ];

    for (const glob of expected) {
      expect(globs).toContain(glob);
    }

    const missingSrcGlob = `${toForwardSlash(path.join(monorepoRoot, "packages", "no-src", "src"))}${extSuffix}`;
    expect(globs).not.toContain(missingSrcGlob);
  });

  it("omits workspace globs whose parent directory does not exist", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-watch-include-minimal-"));
    const monorepoRoot = path.join(tempRoot, "repo");
    const serverRoot = path.join(monorepoRoot, "server");
    fs.mkdirSync(path.join(serverRoot, "src"), { recursive: true });

    const globs = resolveServerDevWatchIncludeGlobs(serverRoot);

    expect(globs).toHaveLength(1);
    expect(globs[0]).toBe(
      `${toForwardSlash(path.join(serverRoot, "src"))}/**/*.{ts,tsx,mts,cts,js,mjs,cjs,json}`,
    );
  });
});

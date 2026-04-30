import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readPnpmImporterPaths,
  runWorkspaceIntegrityCheck,
} from "../ensure-workspace-package-links.ts";

function makeFixtureRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-preflight-fixture-"));
  return fs.realpathSync(dir);
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function writeText(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const lockfileWithIncludedAndExcluded = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.7.3
        version: 5.9.3

  cli:
    dependencies:
      tsx:
        specifier: ^4.19.2
        version: 4.19.2

  packages/included:
    dependencies:
      '@paperclipai/shared':
        specifier: workspace:*
        version: link:../shared

packages:

  tsx@4.19.2:
    resolution: {integrity: sha512-fake}

snapshots:

  tsx@4.19.2: {}
`;

describe("readPnpmImporterPaths", () => {
  let root: string;
  beforeEach(() => {
    root = makeFixtureRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the importer keys with `.` mapped to the empty repo-root string", () => {
    writeText(path.join(root, "pnpm-lock.yaml"), lockfileWithIncludedAndExcluded);
    const importers = readPnpmImporterPaths(root);
    expect(importers).toEqual(new Set(["", "cli", "packages/included"]));
  });

  it("excludes paths that are present on disk but not listed under importers:", () => {
    writeText(path.join(root, "pnpm-lock.yaml"), lockfileWithIncludedAndExcluded);
    const importers = readPnpmImporterPaths(root);
    expect(importers.has("packages/excluded")).toBe(false);
  });

  it("does not pick up snapshot or package keys outside the importers section", () => {
    writeText(path.join(root, "pnpm-lock.yaml"), lockfileWithIncludedAndExcluded);
    const importers = readPnpmImporterPaths(root);
    // `tsx@4.19.2` is a snapshot key, must never be treated as an importer path.
    expect(Array.from(importers).some((entry) => entry.includes("@"))).toBe(false);
  });

  it("throws a clear error when pnpm-lock.yaml is missing", () => {
    expect(() => readPnpmImporterPaths(root)).toThrowError(/pnpm-lock\.yaml not found/);
  });
});

describe("runWorkspaceIntegrityCheck — workspace exclusions", () => {
  let root: string;
  beforeEach(() => {
    root = makeFixtureRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not flag declared deps of packages excluded from pnpm-workspace.yaml", async () => {
    // Lockfile lists only `.`, `cli`, and `packages/included` as importers
    // (mirroring how pnpm-workspace.yaml exclusions remove a path from the
    // post-resolution importer set). `packages/excluded` is on disk with a
    // declared third-party dep that is intentionally NOT installed — pre-fix,
    // the recursive directory walk picked it up and the integrity check failed
    // with "declared package(s) missing".
    writeText(path.join(root, "pnpm-lock.yaml"), lockfileWithIncludedAndExcluded);
    writeJson(path.join(root, "package.json"), {
      name: "fixture-root",
      private: true,
      devDependencies: { typescript: "^5.7.3" },
    });
    // Materialize root devDependency so the root entry of findMissingExternalDeps
    // does not itself raise a false positive (the root is always part of the
    // integrity check, regardless of importer filtering).
    fs.mkdirSync(path.join(root, "node_modules", "typescript"), { recursive: true });

    writeJson(path.join(root, "cli", "package.json"), {
      name: "paperclipai",
      dependencies: { tsx: "^4.19.2" },
    });
    fs.mkdirSync(path.join(root, "cli", "node_modules", "tsx"), { recursive: true });

    writeJson(path.join(root, "packages", "included", "package.json"), {
      name: "@paperclipai/included",
      dependencies: { "@paperclipai/shared": "workspace:*" },
    });

    writeJson(path.join(root, "packages", "excluded", "package.json"), {
      name: "@paperclipai/excluded",
      dependencies: { "some-third-party-dep": "^1.0.0" },
    });
    // Deliberately do NOT create node_modules/some-third-party-dep under the
    // excluded package — this is the regression scenario from AIU-659.

    const result = await runWorkspaceIntegrityCheck(root);

    expect(result.ok).toBe(true);
    expect(result.missingDeps).toEqual([]);
    expect(result.workspaceDirs).toContain("cli");
    expect(result.workspaceDirs).toContain("packages/included");
    expect(result.workspaceDirs).not.toContain("packages/excluded");
  });

  it("still reports missing deps for packages that ARE listed as importers", async () => {
    // Confirms the filter only removes excluded packages; included importers
    // continue to be checked end-to-end.
    writeText(path.join(root, "pnpm-lock.yaml"), lockfileWithIncludedAndExcluded);
    writeJson(path.join(root, "package.json"), { name: "fixture-root", private: true });

    writeJson(path.join(root, "cli", "package.json"), {
      name: "paperclipai",
      dependencies: { tsx: "^4.19.2" },
    });
    // Intentionally do not create cli/node_modules/tsx — cli IS an importer,
    // so the missing-dep error must still surface.

    writeJson(path.join(root, "packages", "included", "package.json"), {
      name: "@paperclipai/included",
    });

    const result = await runWorkspaceIntegrityCheck(root);

    expect(result.ok).toBe(false);
    expect(result.missingDeps.map((dep) => `${dep.workspaceDir}/${dep.packageName}`)).toContain(
      "cli/tsx",
    );
  });
});

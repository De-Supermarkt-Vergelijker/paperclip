#!/usr/bin/env -S node --import tsx
import fs from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve repoRoot inline rather than importing from dev-service-profile.ts so
// this preflight check stays fast — the latter transitively pulls in the full
// local-service-supervisor module graph, which adds ~1s of cold-start cost to
// `pnpm dev`. Keeping this script lean lets it finish under 500ms on a healthy
// workspace (AIU-502 acceptance criterion).
const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type WorkspaceLinkMismatch = {
  workspaceDir: string;
  packageName: string;
  expectedPath: string;
  actualPath: string | null;
};

export type MissingExternalDep = {
  workspaceDir: string;
  packageName: string;
  declaredVersion: string;
};

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

export function discoverWorkspacePackagePaths(rootDir: string): Map<string, string> {
  const packagePaths = new Map<string, string>();
  const ignoredDirNames = new Set([".git", ".paperclip", "dist", "node_modules"]);

  function visit(dirPath: string) {
    if (!existsSync(dirPath)) return;
    const packageJsonPath = path.join(dirPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonFile(packageJsonPath);
      if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
        packagePaths.set(packageJson.name, dirPath);
      }
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (ignoredDirNames.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name));
    }
  }

  visit(path.join(rootDir, "packages"));
  visit(path.join(rootDir, "server"));
  visit(path.join(rootDir, "ui"));
  visit(path.join(rootDir, "cli"));

  return packagePaths;
}

// Parse pnpm-lock.yaml's `importers:` section to learn exactly which workspace
// directories pnpm itself considers part of the install. Used to filter out
// pnpm-workspace.yaml-excluded paths (e.g. plugin sandbox-providers) so this
// preflight does not flag their declared third-party deps as "missing" — pnpm
// correctly never installed them. Returns paths relative to repo root, with
// the lockfile's `.` root importer mapped to "" to match the convention used
// elsewhere in this script.
export function readPnpmImporterPaths(rootDir: string): Set<string> {
  const lockPath = path.join(rootDir, "pnpm-lock.yaml");
  if (!existsSync(lockPath)) {
    throw new Error(
      `pnpm-lock.yaml not found at ${lockPath}. Run \`pnpm install\` before the workspace-link preflight.`,
    );
  }
  const content = readFileSync(lockPath, "utf8");
  const importers = new Set<string>();
  let inImporters = false;
  for (const line of content.split(/\r?\n/)) {
    if (line === "importers:") {
      inImporters = true;
      continue;
    }
    if (!inImporters) continue;
    // The importers section ends when we leave 2-space indentation back to a
    // top-level YAML key (e.g. `packages:`, `snapshots:`).
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) break;
    // Match a 2-space indented importer key line: `  <path>:` with no further
    // value on the same line. Children of the importer (deps, peer deps,
    // version pins) are at >=4-space indent and are correctly skipped.
    const match = /^ {2}([^\s][^:]*?):\s*$/.exec(line);
    if (!match) continue;
    const key = match[1].trim().replace(/^['"]|['"]$/g, "");
    importers.add(key === "." ? "" : key);
  }
  return importers;
}

function ensureWorkspaceContext(rootDir: string): {
  workspacePackagePaths: Map<string, string>;
  workspaceDirs: string[];
} {
  const importerPaths = readPnpmImporterPaths(rootDir);
  const workspacePackagePaths = discoverWorkspacePackagePaths(rootDir);
  const workspaceDirs = Array.from(
    new Set(
      Array.from(workspacePackagePaths.values())
        .map((packagePath) => path.relative(rootDir, packagePath))
        .filter((workspaceDir) => workspaceDir.length > 0 && importerPaths.has(workspaceDir)),
    ),
  ).sort();
  return { workspacePackagePaths, workspaceDirs };
}

export function findWorkspaceLinkMismatches(
  rootDir: string,
  workspaceDir: string,
  workspacePackagePaths: Map<string, string>,
): WorkspaceLinkMismatch[] {
  const nodeModulesDir = path.join(rootDir, workspaceDir, "node_modules");
  if (!existsSync(nodeModulesDir)) {
    return [];
  }

  const packageJson = readJsonFile(path.join(rootDir, workspaceDir, "package.json"));
  const dependencies = {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const mismatches: WorkspaceLinkMismatch[] = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = workspacePackagePaths.get(packageName);
    if (!expectedPath) continue;

    const linkPath = path.join(rootDir, workspaceDir, "node_modules", ...packageName.split("/"));
    const actualPath = existsSync(linkPath) ? path.resolve(realpathSync(linkPath)) : null;
    if (actualPath === path.resolve(expectedPath)) continue;

    mismatches.push({
      workspaceDir,
      packageName,
      expectedPath: path.resolve(expectedPath),
      actualPath,
    });
  }

  return mismatches;
}

async function ensureWorkspaceLinksCurrent(
  rootDir: string,
  workspaceDir: string,
  workspacePackagePaths: Map<string, string>,
) {
  const mismatches = findWorkspaceLinkMismatches(rootDir, workspaceDir, workspacePackagePaths);
  if (mismatches.length === 0) return;

  console.log(`[paperclip] detected stale workspace package links for ${workspaceDir}; relinking dependencies...`);
  for (const mismatch of mismatches) {
    console.log(
      `[paperclip]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}`,
    );
  }

  for (const mismatch of mismatches) {
    const linkPath = path.join(rootDir, mismatch.workspaceDir, "node_modules", ...mismatch.packageName.split("/"));
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(mismatch.expectedPath, linkPath);
  }

  const remainingMismatches = findWorkspaceLinkMismatches(rootDir, workspaceDir, workspacePackagePaths);
  if (remainingMismatches.length === 0) return;

  throw new Error(
    `Workspace relink did not repair all ${workspaceDir} package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
  );
}

// Pass 2: verify every declared external dependency has a materialized entry under
// <workspace>/node_modules. pnpm's content-addressable store can contain the tarball
// while the workspace symlink is absent after an interrupted or partial install
// (see AIU-491: @assistant-ui/react present in store, missing under ui/node_modules,
// Vite then 404s on import and the UI renders black without any signal from
// /api/health). Auto-healing this is pnpm's job — we refuse to start instead.
export function findMissingExternalDeps(rootDir: string, workspaceDir: string): MissingExternalDep[] {
  const packageJsonPath = path.join(rootDir, workspaceDir, "package.json");
  if (!existsSync(packageJsonPath)) return [];

  const packageJson = readJsonFile(packageJsonPath);
  const dependencies = {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.devDependencies as Record<string, unknown> | undefined),
  };

  const missing: MissingExternalDep[] = [];
  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string") continue;
    // workspace: and link: protocols resolve to internal packages or explicit
    // local paths — Pass 1 handles workspace: relinks, and pnpm materializes
    // link: targets directly.
    if (version.startsWith("workspace:")) continue;
    if (version.startsWith("link:")) continue;

    const linkPath = path.join(rootDir, workspaceDir, "node_modules", ...packageName.split("/"));
    let exists = false;
    try {
      // statSync follows symlinks, so a dangling symlink (target missing) also counts as missing.
      statSync(linkPath);
      exists = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (!exists) missing.push({ workspaceDir, packageName, declaredVersion: version });
  }
  return missing;
}

export type WorkspaceIntegrityResult = {
  ok: boolean;
  workspaceDirs: string[];
  missingDeps: MissingExternalDep[];
};

export async function runWorkspaceIntegrityCheck(
  rootDir: string = defaultRepoRoot,
): Promise<WorkspaceIntegrityResult> {
  const { workspacePackagePaths, workspaceDirs } = ensureWorkspaceContext(rootDir);

  for (const workspaceDir of workspaceDirs) {
    await ensureWorkspaceLinksCurrent(rootDir, workspaceDir, workspacePackagePaths);
  }

  const workspaceDirsWithRoot = ["", ...workspaceDirs];
  const missingDeps: MissingExternalDep[] = [];
  for (const workspaceDir of workspaceDirsWithRoot) {
    missingDeps.push(...findMissingExternalDeps(rootDir, workspaceDir));
  }

  return { ok: missingDeps.length === 0, workspaceDirs, missingDeps };
}

const isMainEntrypoint =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainEntrypoint) {
  const result = await runWorkspaceIntegrityCheck();
  if (!result.ok) {
    const workspaceGroups = new Map<string, MissingExternalDep[]>();
    for (const item of result.missingDeps) {
      const key = item.workspaceDir === "" ? "<repo root>" : item.workspaceDir;
      const group = workspaceGroups.get(key);
      if (group) group.push(item);
      else workspaceGroups.set(key, [item]);
    }

    console.error(
      `[paperclip] workspace integrity check FAILED — ${result.missingDeps.length} declared package(s) missing from node_modules:`,
    );
    for (const [workspaceKey, items] of workspaceGroups) {
      console.error(`  ${workspaceKey}:`);
      for (const item of items) {
        console.error(`    - ${item.packageName}@${item.declaredVersion}`);
      }
    }
    console.error("");
    console.error(
      "[paperclip] The pnpm store may hold these packages but the workspace symlinks are stale.",
    );
    console.error("[paperclip] Run: pnpm install --frozen-lockfile");
    process.exit(1);
  }
}

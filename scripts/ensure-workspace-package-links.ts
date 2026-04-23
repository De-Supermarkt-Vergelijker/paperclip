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
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type WorkspaceLinkMismatch = {
  workspaceDir: string;
  packageName: string;
  expectedPath: string;
  actualPath: string | null;
};

type MissingExternalDep = {
  workspaceDir: string;
  packageName: string;
  declaredVersion: string;
};

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function discoverWorkspacePackagePaths(rootDir: string): Map<string, string> {
  const packagePaths = new Map<string, string>();
  const ignoredDirNames = new Set([".git", ".paperclip", "dist", "node_modules"]);

  function visit(dirPath: string) {
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

const workspacePackagePaths = discoverWorkspacePackagePaths(repoRoot);
const workspaceDirs = Array.from(
  new Set(
    Array.from(workspacePackagePaths.values())
      .map((packagePath) => path.relative(repoRoot, packagePath))
      .filter((workspaceDir) => workspaceDir.length > 0),
  ),
).sort();

function findWorkspaceLinkMismatches(workspaceDir: string): WorkspaceLinkMismatch[] {
  const nodeModulesDir = path.join(repoRoot, workspaceDir, "node_modules");
  if (!existsSync(nodeModulesDir)) {
    return [];
  }

  const packageJson = readJsonFile(path.join(repoRoot, workspaceDir, "package.json"));
  const dependencies = {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const mismatches: WorkspaceLinkMismatch[] = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = workspacePackagePaths.get(packageName);
    if (!expectedPath) continue;

    const linkPath = path.join(repoRoot, workspaceDir, "node_modules", ...packageName.split("/"));
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

async function ensureWorkspaceLinksCurrent(workspaceDir: string) {
  const mismatches = findWorkspaceLinkMismatches(workspaceDir);
  if (mismatches.length === 0) return;

  console.log(`[paperclip] detected stale workspace package links for ${workspaceDir}; relinking dependencies...`);
  for (const mismatch of mismatches) {
    console.log(
      `[paperclip]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}`,
    );
  }

  for (const mismatch of mismatches) {
    const linkPath = path.join(repoRoot, mismatch.workspaceDir, "node_modules", ...mismatch.packageName.split("/"));
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(mismatch.expectedPath, linkPath);
  }

  const remainingMismatches = findWorkspaceLinkMismatches(workspaceDir);
  if (remainingMismatches.length === 0) return;

  throw new Error(
    `Workspace relink did not repair all ${workspaceDir} package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
  );
}

for (const workspaceDir of workspaceDirs) {
  await ensureWorkspaceLinksCurrent(workspaceDir);
}

// Pass 2: verify every declared external dependency has a materialized entry under
// <workspace>/node_modules. pnpm's content-addressable store can contain the tarball
// while the workspace symlink is absent after an interrupted or partial install
// (see AIU-491: @assistant-ui/react present in store, missing under ui/node_modules,
// Vite then 404s on import and the UI renders black without any signal from
// /api/health). Auto-healing this is pnpm's job — we refuse to start instead.
function findMissingExternalDeps(workspaceDir: string): MissingExternalDep[] {
  const packageJsonPath = path.join(repoRoot, workspaceDir, "package.json");
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

    const linkPath = path.join(repoRoot, workspaceDir, "node_modules", ...packageName.split("/"));
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

const workspaceDirsWithRoot = ["", ...workspaceDirs];
const missingDeps: MissingExternalDep[] = [];
for (const workspaceDir of workspaceDirsWithRoot) {
  missingDeps.push(...findMissingExternalDeps(workspaceDir));
}

if (missingDeps.length > 0) {
  const workspaceGroups = new Map<string, MissingExternalDep[]>();
  for (const item of missingDeps) {
    const key = item.workspaceDir === "" ? "<repo root>" : item.workspaceDir;
    const group = workspaceGroups.get(key);
    if (group) group.push(item);
    else workspaceGroups.set(key, [item]);
  }

  console.error(
    `[paperclip] workspace integrity check FAILED — ${missingDeps.length} declared package(s) missing from node_modules:`,
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

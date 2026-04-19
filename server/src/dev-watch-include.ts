import fs from "node:fs";
import path from "node:path";

const SOURCE_FILE_EXTENSIONS = "{ts,tsx,mts,cts,js,mjs,cjs,json}";

const WORKSPACE_PACKAGE_GLOBS: readonly string[] = [
  "packages/*",
  "packages/adapters/*",
  "packages/plugins/*",
  "packages/plugins/examples/*",
  "cli",
];

const PACKAGE_SOURCE_SUBDIRS: readonly string[] = ["src", "scripts"];

function toForwardSlash(candidate: string): string {
  return candidate.replaceAll(path.sep, "/");
}

function expandWorkspaceGlob(monorepoRoot: string, relativeGlob: string): string[] {
  const segments = relativeGlob.split("/");
  const lastSegment = segments[segments.length - 1];
  const parentDir = path.join(monorepoRoot, ...segments.slice(0, -1));
  if (!fs.existsSync(parentDir)) return [];
  if (lastSegment !== "*") {
    const candidate = path.join(parentDir, lastSegment);
    return fs.existsSync(candidate) ? [candidate] : [];
  }
  return fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parentDir, entry.name));
}

export function resolveServerDevWatchIncludeGlobs(serverRoot: string): string[] {
  const monorepoRoot = path.resolve(serverRoot, "..");
  const globs = new Set<string>();

  for (const subdir of PACKAGE_SOURCE_SUBDIRS) {
    const candidate = path.join(serverRoot, subdir);
    if (fs.existsSync(candidate)) {
      globs.add(`${toForwardSlash(candidate)}/**/*.${SOURCE_FILE_EXTENSIONS}`);
    }
  }

  for (const relativeGlob of WORKSPACE_PACKAGE_GLOBS) {
    for (const packageRoot of expandWorkspaceGlob(monorepoRoot, relativeGlob)) {
      for (const subdir of PACKAGE_SOURCE_SUBDIRS) {
        const candidate = path.join(packageRoot, subdir);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          globs.add(`${toForwardSlash(candidate)}/**/*.${SOURCE_FILE_EXTENSIONS}`);
        }
      }
    }
  }

  return [...globs];
}

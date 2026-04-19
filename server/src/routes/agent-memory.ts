// Fork-patch: read-only browser for `$AGENT_HOME/memory/` per agent.
// Interim until upstream https://github.com/paperclipai/paperclip/issues/3960.

import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agentService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { resolveDefaultAgentWorkspaceDir, resolveHomeAwarePath } from "../home-paths.js";

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_FILE_BYTE_CAP = 2 * 1024 * 1024;

export interface AgentMemoryRoutesOptions {
  maxDepth?: number;
  fileByteCap?: number;
  resolveAgentMemoryRoot?: (agent: { id: string; adapterConfig: unknown }) => string;
}

export interface MemoryEntry {
  path: string;
  size: number;
  mtime: string;
  isDir: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function defaultResolveAgentMemoryRoot(agent: { id: string; adapterConfig: unknown }): string {
  const cfg = asRecord(agent.adapterConfig);
  const cwd = cfg ? asNonEmptyString(cfg.cwd) : null;
  const base = cwd ? resolveHomeAwarePath(cwd) : resolveDefaultAgentWorkspaceDir(agent.id);
  return path.resolve(base, "memory");
}

// Strict validation for relative paths provided by the client. Rejects null
// bytes, absolute paths, and traversal segments before any filesystem access.
export function validateRelativePath(raw: string): string {
  if (typeof raw !== "string") {
    throw badRequest("Path must be a string");
  }
  if (raw.length === 0) {
    throw badRequest("Path is required");
  }
  if (raw.includes("\0")) {
    throw badRequest("Path contains null byte");
  }
  if (path.isAbsolute(raw)) {
    throw badRequest("Absolute paths are not allowed");
  }
  const rawSegments = raw.split(/[\\/]+/).filter((seg) => seg.length > 0);
  const normalized: string[] = [];
  for (const seg of rawSegments) {
    if (seg === "..") throw badRequest("Traversal segments are not allowed");
    if (seg === ".") continue;
    normalized.push(seg);
  }
  if (normalized.length === 0) {
    throw badRequest("Path resolves to empty after normalization");
  }
  return normalized.join("/");
}

// Ensures the resolved real path stays strictly within the memory root.
// This catches symlinks that point outside the scope (we realpath both sides).
export async function assertWithinRoot(rootRealPath: string, candidate: string): Promise<string> {
  let candidateReal: string;
  try {
    candidateReal = await fs.realpath(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw notFound("Memory file not found");
    throw err;
  }
  const rootWithSep = rootRealPath.endsWith(path.sep) ? rootRealPath : rootRealPath + path.sep;
  if (candidateReal !== rootRealPath && !candidateReal.startsWith(rootWithSep)) {
    throw forbidden("Resolved path escapes memory root");
  }
  return candidateReal;
}

async function listDirectory(
  rootRealPath: string,
  relDir: string,
  depthRemaining: number,
  out: MemoryEntry[],
): Promise<void> {
  if (depthRemaining < 0) return;
  const absDir = path.resolve(rootRealPath, relDir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const entryAbs = path.resolve(absDir, entry.name);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(entryAbs);
    } catch {
      continue;
    }
    // Defence in depth: skip entries whose realpath escapes the root.
    try {
      const real = await fs.realpath(entryAbs);
      const rootWithSep = rootRealPath.endsWith(path.sep) ? rootRealPath : rootRealPath + path.sep;
      if (real !== rootRealPath && !real.startsWith(rootWithSep)) continue;
    } catch {
      continue;
    }
    const isDir = stat.isDirectory();
    out.push({
      path: entryRel,
      size: isDir ? 0 : stat.size,
      mtime: stat.mtime.toISOString(),
      isDir,
    });
    if (isDir && depthRemaining > 0) {
      await listDirectory(rootRealPath, entryRel, depthRemaining - 1, out);
    }
  }
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
      return "text/markdown; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".yml":
    case ".yaml":
      return "application/yaml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export function agentMemoryRoutes(db: Db, opts: AgentMemoryRoutesOptions = {}) {
  const router = Router();
  const svc = agentService(db);
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const fileByteCap = opts.fileByteCap ?? DEFAULT_FILE_BYTE_CAP;
  const resolveRoot = opts.resolveAgentMemoryRoot ?? defaultResolveAgentMemoryRoot;

  async function loadAgentForRequest(req: import("express").Request, id: string) {
    const agent = await svc.getById(id);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    return agent;
  }

  async function rootRealPathForAgent(agent: { id: string; adapterConfig: unknown }): Promise<string> {
    const root = resolveRoot(agent);
    try {
      return await fs.realpath(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw notFound("Memory directory does not exist");
      throw err;
    }
  }

  router.get("/agents/:id/memory-files", async (req, res) => {
    const agent = await loadAgentForRequest(req, req.params.id as string);
    const rootReal = await rootRealPathForAgent(agent);
    const entries: MemoryEntry[] = [];
    await listDirectory(rootReal, "", maxDepth, entries);
    res.json({ entries, maxDepth });
  });

  // Wildcard route — express 5 uses named wildcards. We validate the path
  // string before touching the filesystem.
  router.get("/agents/:id/memory-files/*filePath", async (req, res) => {
    const agent = await loadAgentForRequest(req, req.params.id as string);
    const rawParam = req.params.filePath as string | string[] | undefined;
    const raw = Array.isArray(rawParam) ? rawParam.join("/") : rawParam ?? "";
    const decoded = (() => {
      try {
        return decodeURIComponent(raw);
      } catch {
        throw badRequest("Invalid URL encoding in path");
      }
    })();
    const normalized = validateRelativePath(decoded);
    const rootReal = await rootRealPathForAgent(agent);
    const candidate = path.resolve(rootReal, normalized);
    const resolvedReal = await assertWithinRoot(rootReal, candidate);

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(resolvedReal);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw notFound("Memory file not found");
      throw err;
    }
    if (stat.isDirectory()) {
      throw badRequest("Path refers to a directory, not a file");
    }
    if (stat.size > fileByteCap) {
      res.status(413).json({ error: "File exceeds maximum size", limit: fileByteCap, size: stat.size });
      return;
    }
    const body = await fs.readFile(resolvedReal);
    res.setHeader("Content-Type", contentTypeFor(resolvedReal));
    res.setHeader("Content-Length", String(body.length));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(body);
  });

  return router;
}

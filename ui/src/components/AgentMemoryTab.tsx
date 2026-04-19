// Fork-patch: read-only browser for an agent's $AGENT_HOME/memory/ directory.
// Gated by PAPERCLIP_FEATURE_AGENT_MEMORY_TAB; this component should only be
// rendered when that flag is on. Interim surface per upstream RFC
// https://github.com/paperclipai/paperclip/issues/3960.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import {
  agentsApi,
  type AgentMemoryEntry,
  type AgentMemoryListing,
} from "../api/agents";
import { ApiError } from "../api/client";
import { MarkdownBody } from "./MarkdownBody";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

interface MemoryTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
  children: MemoryTreeNode[];
}

function buildTree(entries: AgentMemoryEntry[]): MemoryTreeNode[] {
  const root: MemoryTreeNode = {
    name: "",
    path: "",
    isDir: true,
    size: 0,
    mtime: "",
    children: [],
  };
  const byPath = new Map<string, MemoryTreeNode>();
  byPath.set("", root);
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const segments = entry.path.split("/");
    const name = segments[segments.length - 1] ?? entry.path;
    const parentPath = segments.slice(0, -1).join("/");
    const parent = byPath.get(parentPath) ?? root;
    const node: MemoryTreeNode = {
      name,
      path: entry.path,
      isDir: entry.isDir,
      size: entry.size,
      mtime: entry.mtime,
      children: [],
    };
    parent.children.push(node);
    byPath.set(entry.path, node);
  }
  function sortNode(node: MemoryTreeNode) {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  }
  sortNode(root);
  return root.children;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

interface TreeRowProps {
  node: MemoryTreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

function TreeRow({ node, depth, selectedPath, expanded, onToggle, onSelect }: TreeRowProps) {
  const isOpen = expanded.has(node.path);
  const indent = 8 + depth * 14;
  if (node.isDir) {
    return (
      <>
        <button
          type="button"
          className="flex items-center gap-1 w-full text-left px-2 py-1 text-xs rounded hover:bg-accent/50"
          style={{ paddingLeft: indent }}
          onClick={() => onToggle(node.path)}
        >
          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {isOpen ? <FolderOpen className="h-3 w-3" /> : <Folder className="h-3 w-3" />}
          <span className="truncate">{node.name || "/"}</span>
        </button>
        {isOpen && node.children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
      </>
    );
  }
  const isSelected = selectedPath === node.path;
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-1 w-full text-left px-2 py-1 text-xs rounded hover:bg-accent/50",
        isSelected && "bg-accent text-accent-foreground",
      )}
      style={{ paddingLeft: indent + 16 }}
      onClick={() => onSelect(node.path)}
    >
      <FileText className="h-3 w-3 shrink-0" />
      <span className="truncate flex-1">{node.name}</span>
      <span className="text-muted-foreground text-[10px] shrink-0">{formatBytes(node.size)}</span>
    </button>
  );
}

export function AgentMemoryTab({ agentId, companyId }: { agentId: string; companyId?: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const listingQuery = useQuery<AgentMemoryListing>({
    queryKey: queryKeys.agents.memoryFiles(agentId),
    queryFn: () => agentsApi.memoryFiles(agentId, companyId),
    retry: false,
  });

  const fileQuery = useQuery({
    queryKey: selectedPath
      ? queryKeys.agents.memoryFile(agentId, selectedPath)
      : ["agent-memory-file-empty"],
    queryFn: () => agentsApi.memoryFile(agentId, selectedPath as string, companyId),
    enabled: !!selectedPath,
    retry: false,
  });

  const tree = useMemo(
    () => (listingQuery.data ? buildTree(listingQuery.data.entries) : []),
    [listingQuery.data],
  );

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (listingQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading memory files…</p>;
  }

  if (listingQuery.error) {
    const err = listingQuery.error;
    const status = err instanceof ApiError ? err.status : null;
    if (status === 404) {
      return (
        <p className="text-sm text-muted-foreground">
          No memory directory exists for this agent yet.
        </p>
      );
    }
    return (
      <p className="text-sm text-destructive">
        Failed to load memory files: {err instanceof Error ? err.message : String(err)}
      </p>
    );
  }

  const entries = listingQuery.data?.entries ?? [];
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">The memory directory is empty.</p>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(220px,_280px)_minmax(0,_1fr)]">
      <div className="border border-border rounded-md overflow-hidden max-h-[600px] overflow-y-auto">
        <div className="border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium">
          Memory files
        </div>
        <div className="py-1">
          {tree.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={toggle}
              onSelect={setSelectedPath}
            />
          ))}
        </div>
      </div>
      <div className="border border-border rounded-md overflow-hidden">
        <div className="border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium flex items-center justify-between">
          <span className="truncate">{selectedPath ?? "Select a file"}</span>
          {selectedPath && fileQuery.data ? (
            <span className="text-muted-foreground text-[10px]">{formatBytes(fileQuery.data.size)}</span>
          ) : null}
        </div>
        <div className="p-4 overflow-auto max-h-[600px]">
          {!selectedPath && (
            <p className="text-sm text-muted-foreground">Pick a file from the tree to preview it.</p>
          )}
          {selectedPath && fileQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {selectedPath && fileQuery.error && (
            <p className="text-sm text-destructive">
              Failed to load file: {fileQuery.error instanceof Error ? fileQuery.error.message : String(fileQuery.error)}
            </p>
          )}
          {selectedPath && fileQuery.data && (
            isMarkdown(selectedPath)
              ? <MarkdownBody>{fileQuery.data.body}</MarkdownBody>
              : <pre className="whitespace-pre-wrap text-xs">{fileQuery.data.body}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

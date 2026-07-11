"use client";

/**
 * MachineFileTree — the Code tab's inner-sidebar file explorer over one branch
 * checkout's working tree (Machine page rebuild, Phase 2).
 *
 * Sibling of MachineTree.tsx and follows its plain border-border inner-sidebar
 * row conventions (this is NOT one of the app's liquid-glass sidebars). Reads
 * `/api/machines/files` (mode=list). Each directory fetches its immediate
 * children only when its listing first becomes visible — a real checkout can be
 * large, so there is deliberately no eager whole-tree walk on mount — and
 * listings are cached per path, so collapsing and re-expanding a folder never
 * refetches. Expansion state lives in one root-level set keyed by path (not in
 * per-node component state), so collapsing a parent does not discard which of
 * its descendants were expanded. The working tree is LIVE (agent terminals
 * write and delete files), so the header offers a manual refresh that drops the
 * whole cache while keeping expansion — every visible directory then reloads.
 * Cache and expansion also reset when the terminal/project/branch identity
 * changes, via a React key remount.
 *
 * Presentation-only about selection: file rows report their checkout-relative
 * path through `onSelectFile`; the Code tab owns what selection does (e.g.
 * driving the Monaco read-only viewer).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MachineDirectoryEntry } from '@pagespace/lib/services/sandbox/machine-fs';
import { cn } from '@/lib/utils';
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { readErrorBody } from '../tabs/checkout-states';

export interface MachineFileTreeProps {
  machineId: string;
  projectName: string;
  branchName: string;
  /** Called with the clicked file's path RELATIVE to the branch checkout root (e.g. `src/index.ts`). Omit to render files as non-interactive rows. */
  onSelectFile?: (path: string) => void;
  /** Checkout-relative path of the file the parent currently shows, for the selected-row highlight. */
  selectedPath?: string | null;
}

type DirectoryState =
  | { status: 'loading' }
  | { status: 'loaded'; entries: MachineDirectoryEntry[] }
  | { status: 'error'; message: string };

/** Everything the recursive nodes need, threaded as one object so recursion doesn't re-plumb six props per level. */
interface TreeContext {
  directories: ReadonlyMap<string, DirectoryState>;
  expandedPaths: ReadonlySet<string>;
  loadDirectory: (path: string) => Promise<void>;
  toggleExpanded: (path: string) => void;
  onSelectFile?: (path: string) => void;
  selectedPath: string | null;
}

/** Directories first, then files, each alphabetical — the universal file-explorer ordering. */
const sortEntries = (entries: MachineDirectoryEntry[]): MachineDirectoryEntry[] =>
  [...entries].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
  );

/**
 * The route's failure body. `error` is written to be shown to a person (the
 * route keeps its own stderr and internal tokens out of it and in `detail`), so
 * it can go straight into the row — see the contract in the files route.
 */
const readErrorMessage = (body: unknown): string | null => readErrorBody(body).error;

export default function MachineFileTree(props: MachineFileTreeProps) {
  // Remount on identity change so the per-path cache and all expansion state
  // reset together — a different branch is a different tree.
  return (
    <FileTreeRoot
      key={`${props.machineId}\u0000${props.projectName}\u0000${props.branchName}`}
      {...props}
    />
  );
}

function FileTreeRoot({ machineId, projectName, branchName, onSelectFile, selectedPath }: MachineFileTreeProps) {
  // The ref is the canonical cache — synchronously readable, so two renders
  // racing the same path (e.g. a collapse/re-expand while the listing is still
  // in flight) can never issue a duplicate fetch. The state map is a snapshot
  // copy for rendering, never the same object the ref mutates.
  const cacheRef = useRef<Map<string, DirectoryState>>(new Map());
  const [directories, setDirectories] = useState<ReadonlyMap<string, DirectoryState>>(new Map());
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());

  const setDirectoryState = useCallback((path: string, state: DirectoryState) => {
    cacheRef.current.set(path, state);
    setDirectories(new Map(cacheRef.current));
  }, []);

  const loadDirectory = useCallback(
    async (path: string) => {
      const existing = cacheRef.current.get(path);
      // Loaded or in flight → cache hit, no refetch. Only an error is retryable.
      if (existing !== undefined && existing.status !== 'error') return;
      setDirectoryState(path, { status: 'loading' });
      try {
        const search = new URLSearchParams({ machineId, projectName, branchName });
        if (path.length > 0) search.set('path', path);
        const res = await fetchWithAuth(`/api/machines/files?${search.toString()}`);
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => null);
          throw new Error(readErrorMessage(body) ?? `Failed to list directory (${res.status})`);
        }
        const body = (await res.json()) as { entries?: unknown };
        if (!Array.isArray(body.entries)) throw new Error('Malformed file listing response');
        setDirectoryState(path, {
          status: 'loaded',
          entries: sortEntries(body.entries as MachineDirectoryEntry[]),
        });
      } catch (err) {
        setDirectoryState(path, {
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to list directory',
        });
      }
    },
    [machineId, projectName, branchName, setDirectoryState],
  );

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  // The working tree is live — drop the whole cache but keep expansion, so
  // every visible directory reloads in place (see DirectoryChildren's effect).
  const refresh = useCallback(() => {
    cacheRef.current = new Map();
    setDirectories(new Map());
  }, []);

  const ctx: TreeContext = {
    directories,
    expandedPaths,
    loadDirectory,
    toggleExpanded,
    onSelectFile,
    selectedPath: selectedPath ?? null,
  };

  return (
    <div className="p-1 text-sm" data-testid="machine-file-tree">
      <div className="flex items-center justify-between py-0.5 pr-1">
        <span className="text-xs text-muted-foreground">Files</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-5"
          title="Refresh files"
          onClick={refresh}
        >
          <RefreshCw className="size-3" />
        </Button>
      </div>
      <DirectoryChildren path="" ctx={ctx} />
    </div>
  );
}

/**
 * The loading/error/empty/entries body for one directory — shared by the root
 * and every expanded folder. Fetch-on-render: becoming visible with no cache
 * entry is what triggers the (lazy) load, which also makes refresh trivial —
 * clearing the cache reloads exactly the directories currently on screen.
 */
function DirectoryChildren({ path, ctx }: { path: string; ctx: TreeContext }) {
  const { loadDirectory } = ctx;
  const state = ctx.directories.get(path);
  const needsLoad = state === undefined;

  useEffect(() => {
    if (needsLoad) void loadDirectory(path);
  }, [needsLoad, loadDirectory, path]);

  if (state === undefined || state.status === 'loading') {
    return <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="flex items-center gap-1 px-2 py-1 text-xs text-destructive">
        <span className="min-w-0 truncate" title={state.message}>
          {state.message}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 shrink-0 px-1.5 text-xs"
          onClick={() => void loadDirectory(path)}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (state.entries.length === 0) {
    return <div className="px-2 py-1 text-xs text-muted-foreground">Empty</div>;
  }
  return (
    <>
      {state.entries.map((entry) => {
        const entryPath = path.length > 0 ? `${path}/${entry.name}` : entry.name;
        return entry.type === 'directory' ? (
          <DirectoryNode key={entry.name} name={entry.name} path={entryPath} ctx={ctx} />
        ) : (
          <FileNode key={entry.name} name={entry.name} path={entryPath} ctx={ctx} />
        );
      })}
    </>
  );
}

function DirectoryNode({ name, path, ctx }: { name: string; path: string; ctx: TreeContext }) {
  const expanded = ctx.expandedPaths.has(path);

  return (
    <div>
      <button
        type="button"
        onClick={() => ctx.toggleExpanded(path)}
        aria-expanded={expanded}
        data-testid="file-tree-dir-toggle"
        className="flex w-full min-w-0 items-center gap-1 rounded-sm py-1 pr-1 text-left hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        {expanded ? (
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{name}</span>
      </button>
      {expanded && (
        <div className="pl-4">
          <DirectoryChildren path={path} ctx={ctx} />
        </div>
      )}
    </div>
  );
}

function FileNode({ name, path, ctx }: { name: string; path: string; ctx: TreeContext }) {
  const selected = ctx.selectedPath === path;
  return (
    <button
      type="button"
      onClick={() => ctx.onSelectFile?.(path)}
      disabled={ctx.onSelectFile === undefined}
      aria-current={selected ? 'true' : undefined}
      data-testid="file-tree-file"
      className={cn(
        'flex w-full min-w-0 items-center gap-1 rounded-sm py-1 pr-1 text-left hover:bg-accent/50',
        selected && 'bg-accent',
        ctx.onSelectFile === undefined && 'cursor-default',
      )}
    >
      {/* Spacer keeps file labels aligned with sibling folder labels (which spend this slot on a chevron). */}
      <span className="size-3.5 shrink-0" aria-hidden="true" />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </button>
  );
}

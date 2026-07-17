"use client";

/**
 * MachineFileTree — the Files tab's file explorer over a Machine's filesystem:
 * either its own root Sprite (`/workspace`) or one project/branch checkout
 * within it, per `FilesScope` (Machine Files Manager epic, Part A).
 *
 * Sibling of MachineTree.tsx and follows its plain border-border inner-sidebar
 * row conventions (this is NOT one of the app's liquid-glass sidebars). Reads
 * `/api/machines/files` (mode=list). Each directory fetches its immediate
 * children only when its listing first becomes visible — a real filesystem can
 * be large, so there is deliberately no eager whole-tree walk on mount — and
 * listings are cached per path, so collapsing and re-expanding a folder never
 * refetches. Expansion state lives in one root-level set keyed by path (not in
 * per-node component state), so collapsing a parent does not discard which of
 * its descendants were expanded. The filesystem is LIVE (agent terminals write
 * and delete files), so the header offers a manual refresh that drops the whole
 * cache while keeping expansion — every visible directory then reloads. Cache
 * and expansion also reset when the machine or scope identity changes, via a
 * React key remount keyed on `filesScopeKey`.
 *
 * Every path handled here — cache keys, `onSelectFile`, `selectedPath` — is
 * relative to the scope root: `/workspace` for root scope, the checkout root
 * for branch scope.
 *
 * Row visuals match the drive sidebar's `PageTreeItem` (the canonical
 * PageSpace filesystem look) — depth-indented rows, a single rotating chevron
 * in the indent gutter, `text-primary` folder icons — without importing it
 * (it's welded to dnd-kit/context-menus/multi-select).
 *
 * Presentation-only about selection: file rows report their scope-relative
 * path through `onSelectFile`; the Files tab owns what selection does (e.g.
 * driving the file pane).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MachineDirectoryEntry } from '@pagespace/lib/services/sandbox/machine-fs';
import { cn } from '@/lib/utils';
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { SidebarLoading, SidebarNotice } from '../tabs/tab-states';
import { readErrorBody } from '../tabs/checkout-states';
import { type FilesScope, filesScopeKey, filesScopeSearchParams } from '../tabs/files-scope';

export interface MachineFileTreeProps {
  machineId: string;
  scope: FilesScope;
  /** Called with the clicked file's path RELATIVE to the scope root (e.g. `src/index.ts`). Omit to render files as non-interactive rows. */
  onSelectFile?: (path: string) => void;
  /** Scope-relative path of the file the parent currently shows, for the selected-row highlight. */
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
  // reset together — a different machine or scope is a different tree.
  return (
    <FileTreeRoot
      key={`${props.machineId}\u0000${filesScopeKey(props.scope)}`}
      {...props}
    />
  );
}

function FileTreeRoot({ machineId, scope, onSelectFile, selectedPath }: MachineFileTreeProps) {
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
        const search = filesScopeSearchParams(machineId, scope);
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
    // Safe without an inline-constructed scope: `scope` is FilesTab state with
    // stable identity across re-renders, AND the key on the exported component
    // remounts this whole tree whenever the scope changes — so this callback
    // never needs to notice a scope change mid-life, only mount fresh with the
    // new one. A scope built fresh on every render here would defeat that and
    // cause a refetch loop.
    [machineId, scope, setDirectoryState],
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
      <DirectoryChildren path="" depth={0} ctx={ctx} />
    </div>
  );
}

/**
 * The loading/error/empty/entries body for one directory — shared by the root
 * and every expanded folder. Fetch-on-render: becoming visible with no cache
 * entry is what triggers the (lazy) load, which also makes refresh trivial —
 * clearing the cache reloads exactly the directories currently on screen.
 * `depth` is the indent level of the ENTRIES rendered here (one deeper than
 * the directory whose children these are), threaded down instead of nested
 * `pl-*` wrapper divs, matching PageTreeItem's flat-indent convention.
 */
function DirectoryChildren({ path, depth, ctx }: { path: string; depth: number; ctx: TreeContext }) {
  const { loadDirectory } = ctx;
  const state = ctx.directories.get(path);
  const needsLoad = state === undefined;

  useEffect(() => {
    if (needsLoad) void loadDirectory(path);
  }, [needsLoad, loadDirectory, path]);

  if (state === undefined || state.status === 'loading') {
    return <SidebarLoading message="Loading files…" />;
  }
  if (state.status === 'error') {
    return (
      <SidebarNotice
        testId="file-tree-error"
        tone="destructive"
        title={state.message}
        actionLabel="Retry"
        onAction={() => void loadDirectory(path)}
      />
    );
  }
  if (state.entries.length === 0) {
    return <SidebarNotice title="Empty folder" />;
  }
  return (
    <>
      {state.entries.map((entry) => {
        const entryPath = path.length > 0 ? `${path}/${entry.name}` : entry.name;
        return entry.type === 'directory' ? (
          <DirectoryNode key={entry.name} name={entry.name} path={entryPath} depth={depth} ctx={ctx} />
        ) : (
          <FileNode key={entry.name} name={entry.name} path={entryPath} depth={depth} ctx={ctx} />
        );
      })}
    </>
  );
}

function DirectoryNode({
  name,
  path,
  depth,
  ctx,
}: {
  name: string;
  path: string;
  depth: number;
  ctx: TreeContext;
}) {
  const expanded = ctx.expandedPaths.has(path);

  return (
    <div>
      <button
        type="button"
        onClick={() => ctx.toggleExpanded(path)}
        aria-expanded={expanded}
        data-testid="file-tree-dir-toggle"
        className="relative flex w-full min-w-0 items-center rounded-lg py-1.5 pr-1 text-left transition-all hover:bg-gray-200 dark:hover:bg-gray-700"
        style={{ paddingLeft: `${depth * 8 + 16}px` }}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'absolute h-3 w-3 shrink-0 text-gray-500 transition-transform duration-200',
            expanded && 'rotate-90',
          )}
          style={{ left: `${depth * 8}px` }}
        />
        {expanded ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-primary" />
        )}
        <span className="ml-1.5 truncate text-sm font-medium text-gray-900 dark:text-gray-100">{name}</span>
      </button>
      {expanded && <DirectoryChildren path={path} depth={depth + 1} ctx={ctx} />}
    </div>
  );
}

function FileNode({
  name,
  path,
  depth,
  ctx,
}: {
  name: string;
  path: string;
  depth: number;
  ctx: TreeContext;
}) {
  const selected = ctx.selectedPath === path;
  return (
    <button
      type="button"
      onClick={() => ctx.onSelectFile?.(path)}
      disabled={ctx.onSelectFile === undefined}
      aria-current={selected ? 'true' : undefined}
      data-testid="file-tree-file"
      style={{ paddingLeft: `${depth * 8 + 16}px` }}
      className={cn(
        'flex w-full min-w-0 items-center rounded-lg py-1.5 pr-1 text-left transition-all',
        selected ? 'bg-gray-200 dark:bg-gray-700' : 'hover:bg-gray-200 dark:hover:bg-gray-700',
        ctx.onSelectFile === undefined && 'cursor-default',
      )}
    >
      <FileIcon className="h-4 w-4 shrink-0 text-gray-500" />
      <span className="ml-1.5 truncate text-sm font-medium text-gray-900 dark:text-gray-100">{name}</span>
    </button>
  );
}

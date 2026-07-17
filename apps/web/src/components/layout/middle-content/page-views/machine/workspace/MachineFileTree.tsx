"use client";

/**
 * MachineFileTree — the Files tab's file explorer over a Machine's filesystem:
 * either its own root Sprite (`/workspace`) or one project/branch checkout
 * within it, per `FilesScope` (Machine Files Manager epic, Part A), plus
 * create/rename/delete management operations over it (Part B, task 11).
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
 *
 * MANAGEMENT OPERATIONS (task 11): directory rows get a right-click menu with
 * New File / New Folder / Rename / Delete; file rows get Rename / Delete; the
 * header gets New File / New Folder targeting the scope root. One shared
 * `FileNameDialog` (a local name-input dialog — the app's page-entity
 * `RenameDialog` doesn't apply to filesystem paths) serves both create and
 * rename; delete uses a local `AlertDialog` confirm naming the scope-relative
 * path.
 *
 * MOVE / COPY (task 12): directory AND file rows also get Move… / Copy…,
 * sharing one `DestinationPathDialog` (`open` picks Move vs Copy by which was
 * clicked). Both PATCH `op: 'move' | 'copy'` with `fromPath`/`toPath`, where
 * `toPath` is exactly what the dialog's input holds — see its module doc for
 * the full-path-including-name semantic. Both invalidate the source AND
 * destination parent directories; move additionally invalidates `fromPath`
 * itself (dropping any cached descendant listings, same as rename) and calls
 * `onPathRenamed` — copy touches nothing at the source, so it calls neither.
 * A 404 (`not_found`, source vanished) additionally re-lists the source
 * parent on its own, since that parent's cached listing is now stale even
 * though the mutation failed.
 *
 * UPLOAD / DOWNLOAD (task 13): a hidden `<input type="file" multiple>`
 * (`fileInputRef`) is triggered from the header (targeting the scope root) or
 * a directory's "Upload here" menu item (targeting that directory);
 * `uploadTargetRef` carries which, since one shared input serves every
 * trigger. Each selected file is read client-side via `FileReader` into
 * base64 and POSTed `kind: 'file', encoding: 'base64'` SEQUENTIALLY (awaited
 * one at a time, not `Promise.all` — concurrent writes into the same
 * directory would race the eventual single re-list); a file over the
 * server's 10 MiB cap is skipped client-side with its own toast rather than
 * making a doomed request. One re-list of the target directory happens after
 * the whole batch, not per file. Download (file rows only) fetches
 * `mode=download` and turns the response into a blob → object-URL →
 * programmatic anchor click, because a bare `<a href>` cannot carry the
 * `fetchWithAuth` auth header.
 *
 * All mutations POST/PATCH/DELETE `/api/machines/files` with the scope fields
 * in the JSON body (mirroring `filesScopeSearchParams`'s pairing rule, but
 * this file doesn't import that helper — `files-scope.ts` is out of scope for
 * this file's tasks). On success, the affected path(s) are dropped from
 * `cacheRef` (see `invalidate`) so the existing fetch-on-render effect
 * re-lists whatever's visible, and a delete/rename/move of the currently-open
 * file bubbles up via `onPathRemoved` / `onPathRenamed` so `FilesTab` can
 * clear or retarget the pane. Failures never become a red tree row for a
 * mutation (rows are for LISTING errors only) — a mutation failure is always
 * a `sonner` toast, optionally prefixed with a file name (see `runMutation`'s
 * `toastPrefix`) so a per-file upload failure names which file it was.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { MachineDirectoryEntry } from '@pagespace/lib/services/sandbox/machine-fs';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  ChevronRight,
  Copy,
  Download,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Move,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { SidebarLoading, SidebarNotice } from '../tabs/tab-states';
import { readErrorBody } from '../tabs/checkout-states';
import { type FilesScope, filesScopeKey, filesScopeSearchParams } from '../tabs/files-scope';
import FileNameDialog from './FileNameDialog';
import DestinationPathDialog from './DestinationPathDialog';

export interface MachineFileTreeProps {
  machineId: string;
  scope: FilesScope;
  /** Called with the clicked file's path RELATIVE to the scope root (e.g. `src/index.ts`). Omit to render files as non-interactive rows. */
  onSelectFile?: (path: string) => void;
  /** Scope-relative path of the file the parent currently shows, for the selected-row highlight. */
  selectedPath?: string | null;
  /** A path was deleted (or, for a directory, everything under it) — parent should clear it if it was (or was an ancestor of) the open file. */
  onPathRemoved?: (path: string) => void;
  /** A path was renamed/moved from `from` to `to` — parent should retarget the open file if `from` was (or was an ancestor of) it. */
  onPathRenamed?: (from: string, to: string) => void;
}

type DirectoryState =
  | { status: 'loading' }
  | { status: 'loaded'; entries: MachineDirectoryEntry[] }
  | { status: 'error'; message: string };

type EntryKind = 'file' | 'directory';

/**
 * One dialog slot shared by New File / New Folder / Rename / Move / Copy /
 * Delete — only ever one of these is open at a time, so a single piece of
 * state (rather than one boolean per op) is enough and can't get two dialogs
 * open together.
 */
type PendingDialog =
  | { kind: 'create'; parentPath: string; entryKind: EntryKind }
  | { kind: 'rename'; path: string; parentPath: string; currentName: string; entryKind: EntryKind }
  | { kind: 'move'; path: string; entryKind: EntryKind }
  | { kind: 'copy'; path: string; entryKind: EntryKind }
  | { kind: 'delete'; path: string; entryKind: EntryKind }
  | null;

/** Everything the recursive nodes need, threaded as one object so recursion doesn't re-plumb props per level. */
interface TreeContext {
  directories: ReadonlyMap<string, DirectoryState>;
  expandedPaths: ReadonlySet<string>;
  loadDirectory: (path: string) => Promise<void>;
  toggleExpanded: (path: string) => void;
  onSelectFile?: (path: string) => void;
  selectedPath: string | null;
  openCreateDialog: (parentPath: string, entryKind: EntryKind) => void;
  openRenameDialog: (path: string, entryKind: EntryKind) => void;
  openMoveCopyDialog: (path: string, entryKind: EntryKind, op: 'move' | 'copy') => void;
  openDeleteDialog: (path: string, entryKind: EntryKind) => void;
  triggerUpload: (targetPath: string) => void;
  downloadFile: (path: string) => void;
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

/** The path's final segment — used for a rename dialog's starting value and the delete confirm's label. */
const basenameOf = (path: string): string => (path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path);

/** The path's parent, scope-relative (`''` for a root-level entry). */
const parentOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

const joinPath = (parentPath: string, name: string): string => (parentPath.length > 0 ? `${parentPath}/${name}` : name);

/**
 * JSON-body scope fields for a mutation. Mirrors `filesScopeSearchParams`'s
 * pairing rule (branch scope sends `projectName`/`branchName`, root scope
 * sends neither) but is local to this file — `files-scope.ts` is out of scope
 * for task 11.
 */
const scopeBodyFields = (machineId: string, scope: FilesScope): Record<string, string> =>
  scope.kind === 'branch'
    ? { machineId, projectName: scope.projectName, branchName: scope.branchName }
    : { machineId };

/**
 * Mirrors the route's own upload cap (`MAX_UPLOAD_BYTES` in
 * `api/machines/files/route.ts`) so an oversized file is rejected here,
 * before a doomed request and its base64 encoding work happen at all. The
 * server enforces its own cap independently — this is a UX shortcut, not the
 * source of truth.
 */
const MAX_CLIENT_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Reads a File client-side into base64 (no data-URL prefix) for the route's `encoding: 'base64'` upload body. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read file'));
        return;
      }
      // `readAsDataURL` yields `data:<mime>;base64,<data>` — only the part
      // after the comma is the base64 payload the route expects.
      const commaIndex = result.indexOf(',');
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

type MutationOutcome = { ok: true } | { ok: false; status: number };

/**
 * POSTs/PATCHes/DELETEs a mutation and turns any failure into the app's toast
 * convention — 403 and 409 get fixed, friendly copy; anything else falls back
 * to the route's own human-readable `error`. `toastPrefix` (used by upload,
 * which fires many of these in one batch) names which file/item a toast is
 * about — e.g. `"report.pdf: File is too large to upload"` — so a failure
 * deep in a multi-file batch is still traceable to its cause. Returns the
 * outcome, including the HTTP status on failure, so a caller can react to a
 * SPECIFIC failure (e.g. move/copy re-listing the source parent only on a 404)
 * without re-deriving it from the toast text; never throws.
 */
async function runMutation(init: RequestInit, options?: { toastPrefix?: string }): Promise<MutationOutcome> {
  const prefix = options?.toastPrefix ? `${options.toastPrefix}: ` : '';
  try {
    const res = await fetchWithAuth('/api/machines/files', {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
    if (res.ok) return { ok: true };
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 403) {
      toast.error(`${prefix}You don't have edit access to this machine`);
    } else if (res.status === 409) {
      toast.error(`${prefix}Something already has that name`);
    } else {
      toast.error(`${prefix}${readErrorMessage(body) ?? `Request failed (${res.status})`}`);
    }
    return { ok: false, status: res.status };
  } catch (err) {
    toast.error(`${prefix}${err instanceof Error ? err.message : 'Request failed'}`);
    return { ok: false, status: 0 };
  }
}

export default function MachineFileTree(props: MachineFileTreeProps) {
  // Remount on identity change so the per-path cache and all expansion state
  // reset together — a different machine or scope is a different tree.
  return (
    <FileTreeRoot
      key={`${props.machineId} ${filesScopeKey(props.scope)}`}
      {...props}
    />
  );
}

function FileTreeRoot({ machineId, scope, onSelectFile, selectedPath, onPathRemoved, onPathRenamed }: MachineFileTreeProps) {
  // The ref is the canonical cache — synchronously readable, so two renders
  // racing the same path (e.g. a collapse/re-expand while the listing is still
  // in flight) can never issue a duplicate fetch. The state map is a snapshot
  // copy for rendering, never the same object the ref mutates.
  const cacheRef = useRef<Map<string, DirectoryState>>(new Map());
  const [directories, setDirectories] = useState<ReadonlyMap<string, DirectoryState>>(new Map());
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());
  const [pendingDialog, setPendingDialog] = useState<PendingDialog>(null);
  const [submitting, setSubmitting] = useState(false);

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

  /**
   * Drops every cache entry equal to (or nested under) any of `paths` — the
   * surgical, per-path sibling of `refresh()`. A directory dropped this way
   * that's currently mounted (visible) re-lists itself via its own
   * fetch-on-render effect; one that's collapsed just refetches lazily next
   * time it's expanded.
   */
  const invalidate = useCallback((paths: string[]) => {
    const next = new Map(cacheRef.current);
    let changed = false;
    for (const key of next.keys()) {
      if (paths.some((p) => key === p || key.startsWith(`${p}/`))) {
        next.delete(key);
        changed = true;
      }
    }
    if (changed) {
      cacheRef.current = next;
      setDirectories(new Map(next));
    }
  }, []);

  const openCreateDialog = useCallback((parentPath: string, entryKind: EntryKind) => {
    setPendingDialog({ kind: 'create', parentPath, entryKind });
  }, []);

  const openRenameDialog = useCallback((path: string, entryKind: EntryKind) => {
    setPendingDialog({ kind: 'rename', path, parentPath: parentOf(path), currentName: basenameOf(path), entryKind });
  }, []);

  const openMoveCopyDialog = useCallback((path: string, entryKind: EntryKind, op: 'move' | 'copy') => {
    setPendingDialog(op === 'move' ? { kind: 'move', path, entryKind } : { kind: 'copy', path, entryKind });
  }, []);

  const openDeleteDialog = useCallback((path: string, entryKind: EntryKind) => {
    setPendingDialog({ kind: 'delete', path, entryKind });
  }, []);

  const closeDialog = useCallback(() => setPendingDialog(null), []);

  const handleCreateOrRenameSubmit = useCallback(
    async (name: string) => {
      if (pendingDialog === null || pendingDialog.kind === 'delete' || pendingDialog.kind === 'move' || pendingDialog.kind === 'copy') return;
      setSubmitting(true);
      try {
        if (pendingDialog.kind === 'create') {
          const { parentPath, entryKind } = pendingDialog;
          const path = joinPath(parentPath, name);
          const result = await runMutation({
            method: 'POST',
            body: JSON.stringify({ ...scopeBodyFields(machineId, scope), path, kind: entryKind }),
          });
          if (!result.ok) return;
          invalidate([parentPath]);
        } else {
          const { path: fromPath, parentPath } = pendingDialog;
          const toPath = joinPath(parentPath, name);
          const result = await runMutation({
            method: 'PATCH',
            body: JSON.stringify({ ...scopeBodyFields(machineId, scope), op: 'move', fromPath, toPath }),
          });
          if (!result.ok) return;
          invalidate([parentPath, fromPath]);
          onPathRenamed?.(fromPath, toPath);
        }
        setPendingDialog(null);
      } finally {
        setSubmitting(false);
      }
    },
    [pendingDialog, machineId, scope, invalidate, onPathRenamed],
  );

  const handleMoveCopySubmit = useCallback(
    async (toPathRaw: string) => {
      if (pendingDialog === null || (pendingDialog.kind !== 'move' && pendingDialog.kind !== 'copy')) return;
      const op = pendingDialog.kind;
      const fromPath = pendingDialog.path;
      const toPath = toPathRaw;
      setSubmitting(true);
      try {
        const result = await runMutation({
          method: 'PATCH',
          body: JSON.stringify({ ...scopeBodyFields(machineId, scope), op, fromPath, toPath }),
        });
        if (!result.ok) {
          // The source's parent listing is now stale if the source itself
          // vanished out from under us — re-list it even though the mutation
          // failed, same as the route contract's `error` toast (already fired
          // by `runMutation`) documents.
          if (result.status === 404) invalidate([parentOf(fromPath)]);
          return;
        }
        // Both ops touch the destination's parent; only a MOVE also empties the
        // source's parent of this entry and invalidates any cached descendant
        // listings under the old path (mirrors rename's cache-drop). Copy
        // leaves the source untouched, so it drops neither.
        invalidate(op === 'move' ? [parentOf(fromPath), parentOf(toPath), fromPath] : [parentOf(fromPath), parentOf(toPath)]);
        if (op === 'move') onPathRenamed?.(fromPath, toPath);
        setPendingDialog(null);
      } finally {
        setSubmitting(false);
      }
    },
    [pendingDialog, machineId, scope, invalidate, onPathRenamed],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (pendingDialog === null || pendingDialog.kind !== 'delete') return;
    const { path } = pendingDialog;
    setSubmitting(true);
    try {
      const result = await runMutation({
        method: 'DELETE',
        body: JSON.stringify({ ...scopeBodyFields(machineId, scope), path }),
      });
      if (!result.ok) return;
      invalidate([parentOf(path), path]);
      onPathRemoved?.(path);
      setPendingDialog(null);
    } finally {
      setSubmitting(false);
    }
  }, [pendingDialog, machineId, scope, invalidate, onPathRemoved]);

  // One shared hidden input serves every upload trigger (header + every
  // directory's "Upload here"); `uploadTargetRef` carries which directory the
  // NEXT file selection targets, set synchronously right before the input is
  // clicked (a ref, not state — no render needs to observe it).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string>('');
  const [uploading, setUploading] = useState(false);

  const triggerUpload = useCallback((targetPath: string) => {
    uploadTargetRef.current = targetPath;
    fileInputRef.current?.click();
  }, []);

  const handleUploadInputChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      const targetPath = uploadTargetRef.current;
      // Reset immediately so selecting the exact same file(s) again still
      // fires a change event.
      e.target.value = '';
      if (fileList === null || fileList.length === 0) return;
      setUploading(true);
      try {
        // Sequential, not concurrent — these all write into the same
        // directory and share one re-list at the end; racing the writes would
        // buy nothing and could reorder failures confusingly.
        for (const file of Array.from(fileList)) {
          if (file.size > MAX_CLIENT_UPLOAD_BYTES) {
            toast.error(`${file.name}: File is too large to upload`);
            continue;
          }
          const content = await readFileAsBase64(file);
          const path = joinPath(targetPath, file.name);
          await runMutation(
            {
              method: 'POST',
              body: JSON.stringify({ ...scopeBodyFields(machineId, scope), path, kind: 'file', encoding: 'base64', content }),
            },
            { toastPrefix: file.name },
          );
        }
        invalidate([targetPath]);
      } finally {
        setUploading(false);
      }
    },
    [machineId, scope, invalidate],
  );

  const downloadFile = useCallback(
    (path: string) => {
      void (async () => {
        try {
          const search = filesScopeSearchParams(machineId, scope);
          search.set('path', path);
          search.set('mode', 'download');
          const res = await fetchWithAuth(`/api/machines/files?${search.toString()}`);
          if (!res.ok) {
            const body: unknown = await res.json().catch(() => null);
            toast.error(readErrorMessage(body) ?? `Failed to download file (${res.status})`);
            return;
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          // A bare `<a href>` cannot carry the `fetchWithAuth` auth header —
          // the blob + object-URL round-trip is what makes an authed download
          // possible from a click the browser treats as same-origin-anonymous.
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = basenameOf(path);
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(url);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Failed to download file');
        }
      })();
    },
    [machineId, scope],
  );

  const ctx: TreeContext = {
    directories,
    expandedPaths,
    loadDirectory,
    toggleExpanded,
    onSelectFile,
    selectedPath: selectedPath ?? null,
    openCreateDialog,
    openRenameDialog,
    openMoveCopyDialog,
    openDeleteDialog,
    triggerUpload,
    downloadFile,
  };

  return (
    <div className="p-1 text-sm" data-testid="machine-file-tree">
      <div className="flex items-center justify-between py-0.5 pr-1">
        <span className="text-xs text-muted-foreground">Files</span>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5"
            title="New file"
            onClick={() => openCreateDialog('', 'file')}
          >
            <FilePlus className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5"
            title="New folder"
            onClick={() => openCreateDialog('', 'directory')}
          >
            <FolderPlus className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5"
            title="Upload files"
            disabled={uploading}
            onClick={() => triggerUpload('')}
          >
            <Upload className="size-3" />
          </Button>
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
      </div>
      {/* Shared by every upload trigger (header + each directory's "Upload
          here"); `uploadTargetRef` carries which directory a given click
          targets. Hidden rather than `sr-only` — it must stay out of layout
          and never receive focus/tab order of its own. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="file-tree-upload-input"
        onChange={(e) => void handleUploadInputChange(e)}
      />
      <DirectoryChildren path="" depth={0} ctx={ctx} />

      <FileNameDialog
        open={pendingDialog?.kind === 'create' || pendingDialog?.kind === 'rename'}
        title={
          pendingDialog?.kind === 'create'
            ? pendingDialog.entryKind === 'directory'
              ? 'New Folder'
              : 'New File'
            : 'Rename'
        }
        initialName={pendingDialog?.kind === 'rename' ? pendingDialog.currentName : ''}
        submitting={submitting}
        onCancel={closeDialog}
        onSubmit={handleCreateOrRenameSubmit}
      />
      <DestinationPathDialog
        open={pendingDialog?.kind === 'move' || pendingDialog?.kind === 'copy'}
        title={pendingDialog?.kind === 'copy' ? 'Copy' : 'Move'}
        initialPath={
          pendingDialog?.kind === 'move' || pendingDialog?.kind === 'copy' ? parentOf(pendingDialog.path) : ''
        }
        submitting={submitting}
        onCancel={closeDialog}
        onSubmit={handleMoveCopySubmit}
      />
      <AlertDialog open={pendingDialog?.kind === 'delete'} onOpenChange={(next) => { if (!next) closeDialog(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &quot;{pendingDialog?.kind === 'delete' ? pendingDialog.path : ''}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes it from the machine. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteConfirm();
              }}
              disabled={submitting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {submitting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onSelect={() => ctx.openCreateDialog(path, 'file')}>
            <FilePlus className="mr-2 h-4 w-4" />
            <span>New File</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ctx.openCreateDialog(path, 'directory')}>
            <FolderPlus className="mr-2 h-4 w-4" />
            <span>New Folder</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => ctx.triggerUpload(path)}>
            <Upload className="mr-2 h-4 w-4" />
            <span>Upload here</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ctx.openMoveCopyDialog(path, 'directory', 'move')}>
            <Move className="mr-2 h-4 w-4" />
            <span>Move…</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ctx.openMoveCopyDialog(path, 'directory', 'copy')}>
            <Copy className="mr-2 h-4 w-4" />
            <span>Copy…</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => ctx.openRenameDialog(path, 'directory')}>
            <Pencil className="mr-2 h-4 w-4" />
            <span>Rename</span>
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onSelect={() => ctx.openDeleteDialog(path, 'directory')}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            <span>Delete</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
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
    <ContextMenu>
      <ContextMenuTrigger asChild>
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
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => ctx.downloadFile(path)}>
          <Download className="mr-2 h-4 w-4" />
          <span>Download</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ctx.openMoveCopyDialog(path, 'file', 'move')}>
          <Move className="mr-2 h-4 w-4" />
          <span>Move…</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ctx.openMoveCopyDialog(path, 'file', 'copy')}>
          <Copy className="mr-2 h-4 w-4" />
          <span>Copy…</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => ctx.openRenameDialog(path, 'file')}>
          <Pencil className="mr-2 h-4 w-4" />
          <span>Rename</span>
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => ctx.openDeleteDialog(path, 'file')}>
          <Trash2 className="mr-2 h-4 w-4" />
          <span>Delete</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

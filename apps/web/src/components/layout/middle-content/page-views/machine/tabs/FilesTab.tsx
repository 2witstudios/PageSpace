"use client";

/**
 * FilesTab — the Machine page's Files tab: a file-system viewer that defaults
 * to the Machine's own root Sprite filesystem (`/workspace`), with a project's
 * branch checkout browsable as an additional, opt-in scope (Machine Files
 * Manager epic, Part A).
 *
 * Composes the pieces the earlier phases landed: an inner page-scoped sidebar
 * (plain border-border chrome, deliberately NOT one of the app's liquid-glass
 * sidebars — same shell as {@link TerminalTab}) holding a BARE {@link MachineTree}
 * as the scope picker, then a {@link MachineFileTree} over whichever scope is
 * selected; and a main pane with a read-only Monaco showing the selected file.
 *
 * A branch checkout only exists on a branch-terminal's OWN Sprite once that
 * branch has been cloned, and nothing in `machine_branches` tracks clone state
 * (the store row carries only a `sandboxId`) — so "is there a checkout?" is
 * answered by the live filesystem, not the DB. Root scope has an absence of
 * its own kind: a Machine whose Terminal was never opened has no Sprite at
 * all yet. The files route gives a clean, typed signal for all three cases:
 * branch resolution failures come back as `reason: 'not_found'` (no tracking
 * row, or the repo dir isn't there) or `reason: 'vanished'` (the row is there
 * but its Sprite is gone); root resolution failure is `reason: 'not_started'`
 * (no Sprite has ever been provisioned). {@link ScopeFiles} probes the scope
 * root once per scope and turns all three into an explicit empty state rather
 * than letting MachineFileTree render them as a raw error row. An
 * `exec_failed` is NOT folded in: a broken exec is a real error and stays one.
 *
 * Selection (scope + open file) is ONE piece of state, and both children are
 * keyed by it. A path only means something inside the scope it came from, so
 * a scope switch drops the open file in the same update — and the key makes
 * the switch a remount, which is what stops a stale `ready` from flashing the
 * file tree at the new scope and firing a listing that gets thrown away. Root
 * is the initial scope, so the Machine's own files render immediately with no
 * pick required; picking a branch is additive, unchanged browsing on top of
 * that default.
 */

import { useCallback, useEffect, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import MachineTree, { type MachineTreeNode } from '../workspace/MachineTree';
import MachineFileTree from '../workspace/MachineFileTree';
import FilesFilePane from './FilesFilePane';
import TabSidebar from './TabSidebar';
import { PaneNotice, SidebarLoading, SidebarNotice } from './tab-states';
import { type FilesScope, filesScopeKey, filesScopeSearchParams } from './files-scope';
import {
  FILES_ABSENT_COPY,
  asAbsentReason,
  readErrorBody,
  type FilesAbsentReason,
} from './checkout-states';

interface FilesTabProps {
  /** The Machine page's own id (= pageId). */
  machineId: string;
}

/** The scope the tab is browsing, and the file open from it. */
interface Selection {
  scope: FilesScope;
  /** Scope-relative path, only ever meaningful within `scope`. */
  path: string | null;
}

const MACHINE_NODE: MachineTreeNode = { level: 'machine' };

/** The `MachineTree` node that corresponds to a scope, for the selection highlight. */
const selectedNodeFor = (scope: FilesScope): MachineTreeNode =>
  scope.kind === 'root'
    ? MACHINE_NODE
    : { level: 'branch', projectName: scope.projectName, branchName: scope.branchName };

export default function FilesTab({ machineId }: FilesTabProps) {
  // Scope and path move as ONE value: a path only means something inside the
  // scope it came from, so switching scopes must drop the open file in the
  // same update — never as a second, separately-scheduled setState. Root is
  // the initial scope, so files render immediately with no pick required.
  const [{ scope, path }, setSelection] = useState<Selection>({ scope: { kind: 'root' }, path: null });

  const onSelectNode = useCallback((node: MachineTreeNode) => {
    // Projects are expand-only groupings with no filesystem of their own —
    // their chevron still works, but selecting one has no scope to switch to.
    if (node.level === 'project') return;
    const nextScope: FilesScope =
      node.level === 'machine'
        ? { kind: 'root' }
        : { kind: 'branch', projectName: node.projectName, branchName: node.branchName };
    setSelection((current) =>
      filesScopeKey(current.scope) === filesScopeKey(nextScope)
        ? current // re-picking the open scope keeps the open file
        : { scope: nextScope, path: null },
    );
  }, []);

  const onSelectFile = useCallback((next: string) => {
    setSelection((current) => ({ ...current, path: next }));
  }, []);

  return (
    <TabSidebar
      title="Files"
      pane={
        path ? (
          // Deliberately UNKEYED. Keying by path would tear down and recreate
          // Monaco on every file click; the pane doesn't need it, because it
          // refuses to render a state belonging to a different file. Keying by
          // scope would be dead code: a scope switch clears `path` in the same
          // update, so the pane unmounts anyway.
          <FilesFilePane machineId={machineId} scope={scope} path={path} />
        ) : (
          <PaneNotice
            icon={<FileCode2 className="size-6 text-muted-foreground" />}
            title="No file open"
            description="Select a file to view its contents."
          />
        )
      }
    >
      {({ close }) => (
        <>
          {/* Picking a BRANCH must not close the sheet on mobile — the file the
              user is actually after is one level further in, in the tree that
              picking the branch just revealed. Only opening a file closes it. */}
          <MachineTree
            machineId={machineId}
            onSelectNode={onSelectNode}
            isNodeSelectable={(n) => n.level !== 'project'}
            selectedNode={selectedNodeFor(scope)}
          />
          <div className="border-t border-border">
            {scope.kind === 'branch' && (
              <div className="flex min-w-0 items-center gap-1 px-2 pt-2 text-xs text-muted-foreground">
                <span className="truncate" title={`${scope.projectName} / ${scope.branchName}`}>
                  {scope.projectName} / {scope.branchName}
                </span>
              </div>
            )}
            {/* Keyed on the scope so a switch REMOUNTS the probe. Without it,
                ScopeFiles would render one frame still holding the previous
                scope's `ready` state, mounting the file tree against the new
                scope — a whole root listing fetched and thrown away before the
                probe effect resets it. This applies to root exactly as much as
                to a branch switch: never special-case root as unkeyed. */}
            <ScopeFiles
              key={filesScopeKey(scope)}
              machineId={machineId}
              scope={scope}
              onSelectFile={(next) => {
                onSelectFile(next);
                close();
              }}
              selectedPath={path}
            />
          </div>
        </>
      )}
    </TabSidebar>
  );
}

/** Whether the scope's filesystem is reachable yet — see the module doc. */
type ScopeState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'absent'; reason: FilesAbsentReason }
  | { status: 'error'; message: string };

/**
 * Probes the scope root once per scope and, only once it answers `ready`,
 * mounts the file tree.
 *
 * COST, stated plainly: the probe is exactly the listing MachineFileTree makes
 * for the root anyway, so a ready scope pays for two root listings — one
 * here, one in the tree. That buys the distinction the tab exists to make:
 * "this scope isn't reachable yet" is a state of the world and belongs in the
 * sidebar as an empty state, not as a red error row buried inside a file
 * tree. The duplicate is bounded — once per scope selection, never per
 * directory, and FilesTab keys us by scope so it cannot fire on a re-render.
 *
 * It is not free, and it is not the only design: MachineFileTree is mounted
 * here and nowhere else, so it could instead report a root-level absence back
 * to us (an `onRootUnavailable(reason)` prop) and the probe would disappear
 * entirely. That is the better end state and a small refactor; it is
 * deliberately not being done in the same PR that changes this route's
 * contract.
 */
function ScopeFiles({
  machineId,
  scope,
  onSelectFile,
  selectedPath,
}: {
  machineId: string;
  scope: FilesScope;
  onSelectFile: (path: string) => void;
  selectedPath: string | null;
}) {
  const [state, setState] = useState<ScopeState>({ status: 'loading' });
  // Bumped by Retry — re-runs the probe without changing the scope identity.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Retry makes an in-flight probe's answer stale — this flag, flipped by the
    // cleanup, keeps it from landing on the newer one. (A scope switch can't
    // race us at all: FilesTab keys this component by scope, so a switch is a
    // remount, not a re-render.)
    let cancelled = false;
    setState({ status: 'loading' });

    const probe = async () => {
      try {
        const search = filesScopeSearchParams(machineId, scope);
        const res = await fetchWithAuth(`/api/machines/files?${search.toString()}`);
        if (cancelled) return;
        if (res.ok) {
          setState({ status: 'ready' });
          return;
        }
        const { error, reason } = readErrorBody(await res.json().catch(() => null));
        if (cancelled) return;
        // `not_found`/`vanished`/`not_started` mean the scope isn't reachable —
        // a state of the world, not a failure. Anything else (403,
        // `exec_failed`, …) IS a failure and must stay visible as one rather
        // than be dressed up as an empty state.
        const absent = asAbsentReason(reason);
        if (absent !== null) {
          setState({ status: 'absent', reason: absent });
          return;
        }
        setState({ status: 'error', message: error ?? `Failed to open files (${res.status})` });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to open files' });
      }
    };

    void probe();
    return () => {
      cancelled = true;
    };
  }, [machineId, scope, attempt]);

  if (state.status === 'loading') {
    return <SidebarLoading message={scope.kind === 'branch' ? 'Opening checkout…' : 'Opening files…'} />;
  }

  const retry = () => setAttempt((a) => a + 1);

  if (state.status === 'absent') {
    const copy = FILES_ABSENT_COPY[state.reason];
    return (
      <SidebarNotice
        testId="checkout-absent"
        title={copy.title}
        description={copy.description}
        actionLabel="Check again"
        onAction={retry}
      />
    );
  }

  if (state.status === 'error') {
    return (
      <SidebarNotice
        testId="checkout-error"
        tone="destructive"
        title={state.message}
        actionLabel="Retry"
        onAction={retry}
      />
    );
  }

  return <MachineFileTree machineId={machineId} scope={scope} onSelectFile={onSelectFile} selectedPath={selectedPath} />;
}

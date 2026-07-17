"use client";

/**
 * FilesTab — the Machine page's Files tab: a read-only viewer over a branch
 * checkout's working tree (Machine page rebuild, Phase 3).
 *
 * Composes the pieces the earlier phases landed: an inner page-scoped sidebar
 * (plain border-border chrome, deliberately NOT one of the app's liquid-glass
 * sidebars — same shell as {@link TerminalTab}) holding a BARE {@link MachineTree}
 * as the branch picker, then a {@link MachineFileTree} over the picked branch's
 * checkout; and a main pane with a read-only Monaco showing the selected file.
 *
 * A checkout only exists on a branch-terminal's OWN Sprite once that branch has
 * been cloned, and nothing in `machine_branches` tracks clone state (the store
 * row carries only a `sandboxId`) — so "is there a checkout?" is answered by the
 * live filesystem, not the DB. The files route already gives a clean, typed
 * signal for it: branch resolution failures come back as `reason: 'not_found'`
 * (no tracking row, or the repo dir isn't there) or `reason: 'vanished'` (the row
 * is there but its Sprite is gone). {@link BranchFiles} probes the checkout root
 * once per branch and turns both into an explicit empty state rather than letting
 * MachineFileTree render them as a raw error row. An `exec_failed` is NOT folded
 * in: a broken exec is a real error and stays one.
 *
 * Selection (branch + open file) is ONE piece of state, and both children are
 * keyed by it. A path only means something inside the checkout it came from, so
 * a branch switch drops the open file in the same update — and the key makes the
 * switch a remount, which is what stops a stale `ready` from flashing the file
 * tree at the new branch and firing a listing that gets thrown away.
 */

import { useCallback, useEffect, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import MachineTree, { type MachineTreeNode } from '../workspace/MachineTree';
import MachineFileTree from '../workspace/MachineFileTree';
import FilesFilePane from './FilesFilePane';
import TabSidebar from './TabSidebar';
import { PaneNotice, SidebarLoading, SidebarNotice } from './tab-states';
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

/** The branch whose checkout the tab is browsing, and the file open from it. */
interface Selection {
  branch: { projectName: string; branchName: string } | null;
  /** Checkout-relative path, only ever meaningful within `branch`. */
  path: string | null;
}

/**
 * Identity of a branch's checkout — also the React key that scopes per-branch
 * state. JSON-encoded rather than joined on a separator so that no project /
 * branch name pair can collide (a branch name may legally contain `/`).
 */
const branchKey = (branch: NonNullable<Selection['branch']>): string =>
  JSON.stringify([branch.projectName, branch.branchName]);

export default function FilesTab({ machineId }: FilesTabProps) {
  // Branch and path move as ONE value: a path only means something inside the
  // checkout it came from, so switching branches must drop the open file in the
  // same update — never as a second, separately-scheduled setState.
  const [{ branch, path }, setSelection] = useState<Selection>({ branch: null, path: null });

  const onSelectNode = useCallback((node: MachineTreeNode) => {
    // Only a branch has a checkout to browse. Machine/Project rows stay
    // expand-only (their chevron still works) — selecting one would have no
    // file tree to show.
    if (node.level !== 'branch') return;
    setSelection((current) =>
      current.branch?.projectName === node.projectName && current.branch.branchName === node.branchName
        ? current // re-picking the open branch keeps the open file
        : { branch: { projectName: node.projectName, branchName: node.branchName }, path: null },
    );
  }, []);

  const onSelectFile = useCallback((next: string) => {
    setSelection((current) => ({ ...current, path: next }));
  }, []);

  return (
    <TabSidebar
      title="Files"
      pane={
        branch && path ? (
          // Deliberately UNKEYED. Keying by path would tear down and recreate
          // Monaco on every file click; the pane doesn't need it, because it
          // refuses to render a state belonging to a different file. Keying by
          // branch would be dead code: a branch switch clears `path` in the same
          // update, so the pane unmounts anyway.
          <FilesFilePane
            machineId={machineId}
            projectName={branch.projectName}
            branchName={branch.branchName}
            path={path}
          />
        ) : (
          <PaneNotice
            icon={<FileCode2 className="size-6 text-muted-foreground" />}
            title={branch ? 'No file open' : 'No branch selected'}
            description={
              branch ? 'Select a file to view its contents.' : 'Select a branch to browse its checkout.'
            }
          />
        )
      }
    >
      {({ close }) => (
        <>
          {/* Picking a BRANCH must not close the sheet on mobile — the file the
              user is actually after is one level further in, in the tree that
              picking the branch just revealed. Only opening a file closes it. */}
          <MachineTree machineId={machineId} onSelectNode={onSelectNode} />
          {branch && (
            <div className="border-t border-border">
              <div className="flex min-w-0 items-center gap-1 px-2 pt-2 text-xs text-muted-foreground">
                <span className="truncate" title={`${branch.projectName} / ${branch.branchName}`}>
                  {branch.projectName} / {branch.branchName}
                </span>
              </div>
              {/* Keyed on the branch so a switch REMOUNTS the probe. Without it,
                  BranchFiles would render one frame still holding the previous
                  branch's `ready` state, mounting the file tree against the new
                  branch — a whole root listing fetched and thrown away before
                  the probe effect resets it. */}
              <BranchFiles
                key={branchKey(branch)}
                machineId={machineId}
                projectName={branch.projectName}
                branchName={branch.branchName}
                onSelectFile={(next) => {
                  onSelectFile(next);
                  close();
                }}
                selectedPath={path}
              />
            </div>
          )}
        </>
      )}
    </TabSidebar>
  );
}

/** Whether the branch's checkout exists on its Sprite yet — see the module doc. */
type CheckoutState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'absent'; reason: FilesAbsentReason }
  | { status: 'error'; message: string };

/**
 * Probes the checkout root once per branch and, only once it answers `ready`,
 * mounts the file tree.
 *
 * COST, stated plainly: the probe is exactly the listing MachineFileTree makes
 * for the root anyway, so a ready branch pays for two root listings — one here,
 * one in the tree. That buys the distinction the tab exists to make: "this
 * branch was never cloned" is a state of the world and belongs in the sidebar as
 * an empty state, not as a red error row buried inside a file tree. The
 * duplicate is bounded — once per branch selection, never per directory, and
 * FilesTab keys us by branch so it cannot fire on a re-render.
 *
 * It is not free, and it is not the only design: MachineFileTree is mounted here
 * and nowhere else, so it could instead report a root-level absence back to us
 * (an `onRootUnavailable(reason)` prop) and the probe would disappear entirely.
 * That is the better end state and a small refactor; it is deliberately not being
 * done in the same PR that changes this route's contract.
 */
function BranchFiles({
  machineId,
  projectName,
  branchName,
  onSelectFile,
  selectedPath,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
  onSelectFile: (path: string) => void;
  selectedPath: string | null;
}) {
  const [state, setState] = useState<CheckoutState>({ status: 'loading' });
  // Bumped by Retry — re-runs the probe without changing the branch identity.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Retry makes an in-flight probe's answer stale — this flag, flipped by the
    // cleanup, keeps it from landing on the newer one. (A branch switch can't
    // race us at all: FilesTab keys this component by branch, so a switch is a
    // remount, not a re-render.)
    let cancelled = false;
    setState({ status: 'loading' });

    const probe = async () => {
      try {
        const search = new URLSearchParams({ machineId, projectName, branchName });
        const res = await fetchWithAuth(`/api/machines/files?${search.toString()}`);
        if (cancelled) return;
        if (res.ok) {
          setState({ status: 'ready' });
          return;
        }
        const { error, reason } = readErrorBody(await res.json().catch(() => null));
        if (cancelled) return;
        // `not_found`/`vanished` mean the checkout isn't there — a state of the
        // world, not a failure. Anything else (403, `exec_failed`, …) IS a
        // failure and must stay visible as one rather than be dressed up as an
        // empty state.
        const absent = asAbsentReason(reason);
        if (absent !== null) {
          setState({ status: 'absent', reason: absent });
          return;
        }
        setState({ status: 'error', message: error ?? `Failed to open checkout (${res.status})` });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to open checkout' });
      }
    };

    void probe();
    return () => {
      cancelled = true;
    };
  }, [machineId, projectName, branchName, attempt]);

  if (state.status === 'loading') {
    return <SidebarLoading message="Opening checkout…" />;
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

  return (
    <MachineFileTree
      machineId={machineId}
      projectName={projectName}
      branchName={branchName}
      onSelectFile={onSelectFile}
      selectedPath={selectedPath}
    />
  );
}

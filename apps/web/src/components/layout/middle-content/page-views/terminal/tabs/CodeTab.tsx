"use client";

/**
 * CodeTab — the Machine page's Code tab (Machine page rebuild, Phase 3).
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
 * MachineFileTree render them as a raw error row.
 */

import { useCallback, useEffect, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import MachineTree, { type MachineTreeNode } from '../workspace/MachineTree';
import MachineFileTree from '../workspace/MachineFileTree';
import CodeFilePane from './CodeFilePane';

interface CodeTabProps {
  /** The Machine page's own id (= pageId). */
  machineId: string;
}

/** The branch whose checkout the tab is currently browsing. */
interface SelectedBranch {
  projectName: string;
  branchName: string;
}

export default function CodeTab({ machineId }: CodeTabProps) {
  const [branch, setBranch] = useState<SelectedBranch | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const onSelectNode = useCallback((node: MachineTreeNode) => {
    // Only a branch has a checkout to browse. Machine/Project rows stay
    // expand-only (their chevron still works) — selecting one would have no
    // file tree to show.
    if (node.level !== 'branch') return;
    setBranch((current) =>
      current?.projectName === node.projectName && current.branchName === node.branchName
        ? current
        : { projectName: node.projectName, branchName: node.branchName },
    );
    // A path is only meaningful within one checkout, so switching branches
    // drops the open file rather than trying to resolve it in the new tree.
    setSelectedPath((current) =>
      branchEquals(node, branch) ? current : null,
    );
  }, [branch]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Code</span>
        </div>
        <ScrollArea className="flex-1">
          <MachineTree machineId={machineId} onSelectNode={onSelectNode} />
          {branch && (
            <div className="border-t border-border">
              <div className="flex min-w-0 items-center gap-1 px-2 pt-2 text-xs text-muted-foreground">
                <span className="truncate" title={`${branch.projectName} / ${branch.branchName}`}>
                  {branch.projectName} / {branch.branchName}
                </span>
              </div>
              <BranchFiles
                machineId={machineId}
                projectName={branch.projectName}
                branchName={branch.branchName}
                onSelectFile={setSelectedPath}
                selectedPath={selectedPath}
              />
            </div>
          )}
        </ScrollArea>
      </aside>
      <div className="min-w-0 flex-1">
        {branch && selectedPath ? (
          <CodeFilePane
            machineId={machineId}
            projectName={branch.projectName}
            branchName={branch.branchName}
            path={selectedPath}
          />
        ) : (
          <CodeTabPlaceholder hasBranch={branch !== null} />
        )}
      </div>
    </div>
  );
}

const branchEquals = (node: Extract<MachineTreeNode, { level: 'branch' }>, branch: SelectedBranch | null): boolean =>
  branch !== null && branch.projectName === node.projectName && branch.branchName === node.branchName;

function CodeTabPlaceholder({ hasBranch }: { hasBranch: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <FileCode2 className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {hasBranch ? 'Select a file to view its contents.' : 'Select a branch to browse its checkout.'}
      </p>
    </div>
  );
}

/** Whether the branch's checkout exists on its Sprite yet — see the module doc. */
type CheckoutState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'absent'; reason: 'not_found' | 'vanished' }
  | { status: 'error'; message: string };

const ABSENT_COPY: Record<'not_found' | 'vanished', { title: string; description: string }> = {
  not_found: {
    title: "This branch hasn't been checked out yet",
    description: 'Open a terminal on this branch to clone it, then refresh.',
  },
  vanished: {
    title: 'This branch checkout is gone',
    description: 'Its sandbox was reclaimed. Open a terminal on the branch to check it out again.',
  },
};

const readBody = (body: unknown): { reason?: string; error?: string } => {
  if (body === null || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  return {
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
  };
};

/**
 * Probes the checkout root once per branch and, only once it answers `ready`,
 * mounts the file tree. The probe is exactly the listing MachineFileTree would
 * make for the root anyway — paying it here is what lets a missing checkout be
 * an empty state instead of an error row inside the tree.
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
    // A branch switch (or retry) makes an in-flight probe's answer stale — this
    // flag, flipped by the cleanup, is what keeps it from landing on the new one.
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
        const { reason, error } = readBody(await res.json().catch(() => null));
        if (cancelled) return;
        if (reason === 'not_found' || reason === 'vanished') {
          setState({ status: 'absent', reason });
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
    return <div className="px-3 py-2 text-xs text-muted-foreground">Opening checkout…</div>;
  }

  if (state.status === 'absent') {
    const copy = ABSENT_COPY[state.reason];
    return (
      <div className="flex flex-col items-start gap-1 px-3 py-2" data-testid="checkout-absent">
        <p className="text-xs font-medium">{copy.title}</p>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={() => setAttempt((a) => a + 1)}
        >
          Check again
        </Button>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-1 px-3 py-2">
        <p className="min-w-0 truncate text-xs text-destructive" title={state.message}>
          {state.message}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={() => setAttempt((a) => a + 1)}
        >
          Retry
        </Button>
      </div>
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

"use client";

import { useCallback, useState } from 'react';
import { useSWRConfig } from 'swr';
import { GitCompare, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMachineDiffFiles, isMachineDiffKey } from '@/hooks/useMachineDiff';
import { isMachineDiffScope, type MachineDiffScope } from '@pagespace/lib/services/sandbox/machine-diff-scope';
import MachineTree, { type MachineTreeNode } from '../workspace/MachineTree';
import DiffFileCard from './DiffFileCard';

const SCOPE_LABELS: Record<MachineDiffScope, string> = {
  uncommitted: 'Uncommitted',
  committed: 'Committed',
  branch: 'Branch vs master',
};

interface SelectedBranch {
  projectName: string;
  branchName: string;
}

/**
 * The empty state for a clean scope. The main-branch case names the branch
 * explicitly ("No uncommitted changes on main") — on the default branch
 * Uncommitted is the ONLY scope, so an unqualified "no changes" would leave the
 * user wondering what happened to the other two.
 */
function emptyMessage(scope: MachineDiffScope, branchName: string, scopesApplicable: boolean): string {
  if (scope === 'uncommitted') {
    return scopesApplicable ? 'No uncommitted changes' : `No uncommitted changes on ${branchName}`;
  }
  if (scope === 'committed') return `No commits on ${branchName} yet`;
  return `${branchName} is identical to the default branch`;
}

/**
 * The Machine page's Diff tab: the shared {@link MachineTree} in BARE mode as an
 * inner sidebar (no session leaves — the Project/Branch rows themselves are the
 * diff target), beside a 3-way scope toggle over the selected branch's changed
 * files. Each file expands into its own `MonacoDiffEditor`, so a 200-file branch
 * renders 200 cheap header rows and zero editors until one is opened.
 */
export default function DiffTab({ machineId }: { machineId: string }) {
  const [selected, setSelected] = useState<SelectedBranch | null>(null);

  const onSelectNode = useCallback((node: MachineTreeNode) => {
    // Only a branch identifies a checkout to diff; Machine/Project rows are
    // navigation-only here (clicking them still expands via TreeRow).
    if (node.level !== 'branch') return;
    setSelected({ projectName: node.projectName, branchName: node.branchName });
  }, []);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Branches</span>
        </div>
        <ScrollArea className="flex-1">
          <MachineTree machineId={machineId} onSelectNode={onSelectNode} />
        </ScrollArea>
      </aside>
      <div className="min-w-0 flex-1">
        {selected === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <GitCompare className="size-5" />
            <span>Select a branch to view its diff.</span>
          </div>
        ) : (
          <BranchDiffPane
            // Remounting per branch resets the scope selection and expanded
            // cards, so a stale scope can never carry across a branch switch.
            key={`${selected.projectName}/${selected.branchName}`}
            machineId={machineId}
            projectName={selected.projectName}
            branchName={selected.branchName}
          />
        )}
      </div>
    </div>
  );
}

/** The scope toggle + changed-file list for ONE selected branch. */
function BranchDiffPane({
  machineId,
  projectName,
  branchName,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
}) {
  const [scope, setScope] = useState<MachineDiffScope>('uncommitted');

  // The 'committed' list doubles as the main-branch PROBE: on the repo's main
  // branch the route answers `{ notApplicable: true }` for both non-uncommitted
  // scopes (it can't merge-base a branch with itself), which is how we learn the
  // toggle must collapse to Uncommitted alone — never by string-matching the
  // branch name here, and never by inferring it from an empty file list. When
  // the scope IS applicable this same response is the committed scope's list, so
  // SWR serves it from cache on select rather than refetching.
  const committed = useMachineDiffFiles(machineId, projectName, branchName, 'committed');
  const probeResolved = committed.data !== undefined || committed.error !== undefined;
  // An errored probe (machine stopped, git failure) is NOT a main-branch answer,
  // so the full toggle stays available and the error surfaces on the list below.
  const scopesApplicable = committed.data?.notApplicable !== true;

  const active: MachineDiffScope = scopesApplicable ? scope : 'uncommitted';
  const list = useMachineDiffFiles(machineId, projectName, branchName, active);

  // Revalidate the WHOLE diff surface, not just the two lists this pane holds:
  // every expanded card owns a separate pair key, and refreshing only the lists
  // would leave an open Monaco diff showing pre-edit content indefinitely (the
  // pair hook sets revalidateOnFocus: false, so nothing else would ever refetch
  // it). The keyed predicate catches lists and pairs alike.
  const { mutate } = useSWRConfig();
  const refresh = useCallback(() => {
    void mutate(isMachineDiffKey);
  }, [mutate]);

  const availableScopes: MachineDiffScope[] = scopesApplicable
    ? ['uncommitted', 'committed', 'branch']
    : ['uncommitted'];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground">
            {projectName}/{branchName}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!probeResolved ? (
            <span className="text-xs text-muted-foreground">Loading scopes…</span>
          ) : (
            <Tabs
              value={active}
              onValueChange={(value) => {
                if (isMachineDiffScope(value)) setScope(value);
              }}
            >
              <TabsList>
                {availableScopes.map((option) => (
                  <TabsTrigger key={option} value={option}>
                    {SCOPE_LABELS[option]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          <Button variant="ghost" size="icon" className="size-8" onClick={refresh} title="Refresh diff">
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {/* Hold the list until the probe answers: rendering it first would show
            a generic "No uncommitted changes" that then flips to the
            main-branch-specific copy once applicability is known. */}
        {!probeResolved ? (
          <div className="p-4 text-sm text-muted-foreground">Loading changed files…</div>
        ) : (
          <DiffFileList
            machineId={machineId}
            projectName={projectName}
            branchName={branchName}
            scope={active}
            scopesApplicable={scopesApplicable}
            list={list}
          />
        )}
      </ScrollArea>
    </div>
  );
}

function DiffFileList({
  machineId,
  projectName,
  branchName,
  scope,
  scopesApplicable,
  list,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
  scope: MachineDiffScope;
  scopesApplicable: boolean;
  list: ReturnType<typeof useMachineDiffFiles>;
}) {
  const { data, error, isLoading } = list;

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading changed files…</div>;
  }
  if (error) {
    return <div className="p-4 text-sm text-destructive">Failed to load diff: {error.message}</div>;
  }
  if (!data) {
    return <div className="p-4 text-sm text-muted-foreground">Loading changed files…</div>;
  }
  if (data.notApplicable) {
    // The toggle normally prevents this (a not-applicable scope isn't offered),
    // but say so explicitly rather than render a blank pane — a transiently
    // failed probe can leave the full toggle up on a main branch, and an empty
    // white pane would read as "no changes", which is a different claim.
    return (
      <div className="p-4 text-sm text-muted-foreground">
        This scope doesn&apos;t apply on <span className="font-mono">{branchName}</span> — it is the repository&apos;s
        default branch, so there is nothing to compare it against.
      </div>
    );
  }
  if (data.files.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">{emptyMessage(scope, branchName, scopesApplicable)}</div>;
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      {data.truncated && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This diff is too large to list in full — some changed files are not shown.
        </div>
      )}
      {data.files.map((file) => (
        <DiffFileCard
          key={`${file.status}:${file.previousPath ?? ''}:${file.path}`}
          machineId={machineId}
          projectName={projectName}
          branchName={branchName}
          scope={scope}
          file={file}
        />
      ))}
    </div>
  );
}

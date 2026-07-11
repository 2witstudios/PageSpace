"use client";

import { useCallback, useState } from 'react';
import { useSWRConfig } from 'swr';
import { GitCompare, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useMachineDiffFiles, isMachineDiffKey } from '@/hooks/useMachineDiff';
import { isMachineDiffScope, type MachineDiffScope } from '@pagespace/lib/services/sandbox/machine-diff-scope';
import MachineTree, { type MachineTreeNode } from '../workspace/MachineTree';
import DiffFileCard from './DiffFileCard';

const SCOPE_LABELS: Record<MachineDiffScope, string> = {
  uncommitted: 'Uncommitted',
  committed: 'Committed',
  // "vs default", not "vs master": the server diffs against `origin/HEAD` — the
  // remote's ACTUAL default branch — precisely so the scope is correct whether a
  // repo's default is master, main, or anything else (see machine-diff-scope.ts,
  // which refuses to hardcode the literal). Labeling it "vs master" would name a
  // branch that doesn't exist on a main-default repo, and would contradict this
  // file's own empty state ("identical to the default branch").
  branch: 'Branch vs default',
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
 * inner sidebar (no session leaves), beside a 3-way scope toggle over the
 * selected branch's changed files. Each file expands into its own
 * `MonacoDiffEditor`, so a 200-file branch renders 200 cheap header rows and zero
 * editors until one is opened.
 *
 * BRANCH rows are the diff target — a Machine or Project spans many checkouts and
 * has no single working tree to compare, so those rows stay pure navigation
 * (see `isNodeSelectable`).
 */
export default function DiffTab({ machineId }: { machineId: string }) {
  const [selected, setSelected] = useState<SelectedBranch | null>(null);

  // Only a branch identifies a checkout to diff. Machine/Project rows are
  // navigation-only, so they must NOT be marked selectable — a row with a select
  // handler uses it INSTEAD of expand-on-label-click, which would leave those
  // labels as dead buttons that swallow the click and do nothing.
  const isNodeSelectable = useCallback((node: MachineTreeNode) => node.level === 'branch', []);

  const onSelectNode = useCallback((node: MachineTreeNode) => {
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
          <MachineTree machineId={machineId} onSelectNode={onSelectNode} isNodeSelectable={isNodeSelectable} />
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

  const refreshing = list.isValidating || committed.isValidating;

  return (
    // Tabs wraps the triggers AND the panel on purpose: a Radix TabsTrigger emits
    // aria-controls pointing at its TabsContent, so a TabsList with no TabsContent
    // would leave every tab referencing an element id that exists nowhere in the
    // DOM (a tablist owning no tabpanel — invalid ARIA, and a screen reader
    // announces a panel the user can never reach).
    <Tabs
      value={active}
      onValueChange={(value) => {
        if (isMachineDiffScope(value)) setScope(value);
      }}
      className="flex h-full min-h-0 flex-col gap-0"
    >
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
            <TabsList>
              {availableScopes.map((option) => (
                <TabsTrigger key={option} value={option}>
                  {SCOPE_LABELS[option]}
                </TabsTrigger>
              ))}
            </TabsList>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={refresh}
            disabled={refreshing}
            title="Refresh diff"
            aria-label="Refresh diff"
          >
            {/* Without this the click has no visible effect until the sandbox
                answers — SWR keeps the stale data and only flips isValidating. */}
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Hold the list until the probe answers: rendering it first would show a
          generic "No uncommitted changes" that then flips to the main-branch
          copy once applicability is known. */}
      {!probeResolved ? (
        <div className="p-4 text-sm text-muted-foreground">Loading changed files…</div>
      ) : (
        availableScopes.map((option) => (
          // Radix renders only the ACTIVE scope's content, so this is one list,
          // not three — it just gives each trigger a real panel to control.
          <TabsContent key={option} value={option} className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <DiffFileList
                machineId={machineId}
                projectName={projectName}
                branchName={branchName}
                scope={active}
                scopesApplicable={scopesApplicable}
                list={list}
              />
            </ScrollArea>
          </TabsContent>
        ))
      )}
    </Tabs>
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
  // `truncated` is checked BEFORE the empty state: a list cut at the output cap
  // before its first complete entry comes back as `{ files: [], truncated: true }`,
  // and reporting that as "no changes" would be the one place this pane claims a
  // clean tree on partial data.
  if (data.files.length === 0 && !data.truncated) {
    return <div className="p-4 text-sm text-muted-foreground">{emptyMessage(scope, branchName, scopesApplicable)}</div>;
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      {data.truncated && (
        <div className="rounded-md border border-border bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          This diff is too large to list in full — some changed files are not shown.
        </div>
      )}
      {data.files.map((file) => (
        <DiffFileCard
          // Keyed by IDENTITY (path + rename source), deliberately not by status:
          // a refresh that flips a file modified -> deleted would otherwise change
          // its key, remount the card, and silently collapse it under the user.
          // Status is already a prop, so it still re-renders in place.
          key={`${file.previousPath ?? ''}:${file.path}`}
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

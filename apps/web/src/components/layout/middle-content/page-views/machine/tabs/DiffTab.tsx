"use client";

import { useCallback, useState } from 'react';
import { useSWRConfig } from 'swr';
import { GitCompare, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useMachineDiffFiles, machineDiffKeyFilter, type MachineDiffFilesResponse } from '@/hooks/useMachineDiff';
import { isMachineDiffScope, type MachineDiffScope } from '@pagespace/lib/services/sandbox/machine-diff-scope';
import MachineTree, { type MachineTreeNode } from '../workspace/MachineTree';
import DiffFileCard from './DiffFileCard';
import TabSidebar from './TabSidebar';
import { PaneLoading, PaneNotice, Spinner } from './tab-states';

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
  // "No committed CHANGES", not "no commits": this scope measures the
  // merge-base..HEAD diff, and a branch whose commits cancel out (a change plus
  // its revert, or empty/merge commits) has commits but an empty diff. Say what
  // was actually measured.
  if (scope === 'committed') return `No committed changes on ${branchName}`;
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
    <TabSidebar
      title="Branches"
      pane={
        selected === null ? (
          <PaneNotice
            icon={<GitCompare className="size-6 text-muted-foreground" />}
            title="No branch selected"
            description="Select a branch to view its diff."
          />
        ) : (
          <BranchDiffPane
            // Remounting per branch resets the scope selection and expanded
            // cards, so a stale scope can never carry across a branch switch.
            // NUL-joined: branch names contain '/', so a '/' separator could let
            // two different (project, branch) pairs collide on one key.
            key={`${selected.projectName}\u0000${selected.branchName}`}
            machineId={machineId}
            projectName={selected.projectName}
            branchName={selected.branchName}
          />
        )
      }
    >
      {({ close }) => (
        <MachineTree
          machineId={machineId}
          onSelectNode={(node) => {
            onSelectNode(node);
            // Only branch rows select (see isNodeSelectable), and selecting one IS
            // the navigation here — on a narrow viewport the diff it opens is
            // behind the sheet the tree is in.
            if (node.level === 'branch') close();
          }}
          isNodeSelectable={isNodeSelectable}
          // Without this the tree gives no sign of which branch is being
          // diffed — the only clue would be the path in the pane header.
          selectedNode={
            selected ? { level: 'branch', projectName: selected.projectName, branchName: selected.branchName } : null
          }
        />
      )}
    </TabSidebar>
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

  // Revalidate every key of THIS branch's diff — not just the two lists this pane
  // holds, because each expanded card owns a separate pair key and refreshing only
  // the lists would leave an open Monaco diff serving pre-edit content forever
  // (the pair hook sets revalidateOnFocus: false, so nothing else would refetch
  // it). Scoped to the branch, so refreshing here can't re-fire the git execs of
  // another Machine page that's merely kept mounted in the keep-alive LRU.
  const { mutate } = useSWRConfig();
  const refresh = useCallback(() => {
    void mutate(machineDiffKeyFilter(machineId, projectName, branchName));
  }, [mutate, machineId, projectName, branchName]);

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
      {/* Stacks on a narrow viewport: the path, a 3-way toggle and the refresh
          button do not fit one phone-width row, and squeezing them produces a
          toggle whose labels are all ellipsis. */}
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground">
            {projectName}/{branchName}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {!probeResolved ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Loading scopes…
            </span>
          ) : (
            // The three scope labels overflow a phone-width row, so the toggle
            // scrolls sideways rather than compressing its triggers to nothing.
            <div className="min-w-0 overflow-x-auto">
              <TabsList>
                {availableScopes.map((option) => (
                  <TabsTrigger key={option} value={option}>
                    {SCOPE_LABELS[option]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            // shrink-0: its sibling is a scrolling toggle in a min-w-0 row, so
            // without this the flex layout would squeeze the button instead of
            // letting the toggle scroll.
            className="size-8 shrink-0"
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
        <PaneLoading message="Loading changed files…" />
      ) : (
        // ONE PANEL PER SCOPE, and this is NOT redundant — a simplification pass
        // collapsed it to a single `<TabsContent value={active}>` on the premise
        // that Radix unmounts inactive panels. It does not: Tabs hands `children`
        // to Presence AS A FUNCTION, which force-mounts, so the panel <div> always
        // renders (only its children are gated). Two things depend on that:
        //
        //  1. every trigger's `aria-controls` resolves to a real element. With one
        //     panel, the two inactive triggers point at ids present nowhere in the
        //     DOM — the exact dangling-IDREF violation the Tabs wrapper above
        //     exists to avoid.
        //  2. one panel PER SCOPE means switching scope unmounts the old panel's
        //     children (Presence gates them on `present`). Collapsed to a single
        //     panel, an expanded card whose path exists in both scopes stays open
        //     across the switch and immediately refetches its pair — an extra
        //     sandbox git exec per open card, every switch.
        //
        // Radix renders only the ACTIVE panel's children, so this is still one
        // rendered list, not three.
        availableScopes.map((option) => (
          <TabsContent key={option} value={option} className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <DiffFileList
                machineId={machineId}
                projectName={projectName}
                branchName={branchName}
                scope={active}
                scopesApplicable={scopesApplicable}
                data={list.data}
                error={list.error}
                onRetry={refresh}
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
  data,
  error,
  onRetry,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
  scope: MachineDiffScope;
  scopesApplicable: boolean;
  data: MachineDiffFilesResponse | undefined;
  error: Error | undefined;
  /** Revalidates this branch's diff — the same action the header's refresh runs. */
  onRetry: () => void;
}) {
  if (error) {
    return (
      <PaneNotice
        tone="destructive"
        title="Failed to load diff"
        description={error.message}
        actionLabel="Retry"
        onAction={onRetry}
      />
    );
  }
  // Error FIRST, then no-data-yet. SWR reads data/error from the CURRENT key's
  // cache entry, so on a scope switch `data` is immediately undefined and the
  // previous scope's diff can never leak — this is the loading state, and a
  // separate isLoading branch said the same thing twice.
  //
  // The order also matters on a retry: SWR's isLoading is "in flight AND no data",
  // regardless of a cached error, so an errored key that auto-retries would flicker
  // Loading <-> Failed if isLoading were checked first. Holding the error steady and
  // signalling the retry through the spinning Refresh icon is the honest reading.
  if (!data) {
    return <PaneLoading message="Loading changed files…" />;
  }
  if (data.notApplicable) {
    // The toggle normally prevents this (a not-applicable scope isn't offered),
    // but say so explicitly rather than render a blank pane — a transiently
    // failed probe can leave the full toggle up on a main branch, and an empty
    // white pane would read as "no changes", which is a different claim.
    return (
      <PaneNotice
        title={`This scope doesn't apply on ${branchName}`}
        description="It is the repository's default branch, so there is nothing to compare it against."
      />
    );
  }
  // `truncated` is checked BEFORE the empty state: a list cut at the output cap
  // before its first complete entry comes back as `{ files: [], truncated: true }`,
  // and reporting that as "no changes" would be the one place this pane claims a
  // clean tree on partial data.
  if (data.files.length === 0 && !data.truncated) {
    return (
      <PaneNotice
        icon={<GitCompare className="size-6 text-muted-foreground" />}
        title={emptyMessage(scope, branchName, scopesApplicable)}
      />
    );
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
          // Status is already a prop, so it still re-renders in place. NUL-joined
          // because a path may legally contain ':'.
          key={`${file.previousPath ?? ''}\u0000${file.path}`}
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

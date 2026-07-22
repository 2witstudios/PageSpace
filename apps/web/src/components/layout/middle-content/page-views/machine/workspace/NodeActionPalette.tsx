"use client";

/**
 * The single "+" per Machine/Project/Branch row (Terminal UX redesign,
 * add-palette consolidation). One `+` per row, one Raycast-style palette,
 * actions scoped to what that node can actually do:
 *
 * - Machine node: Agent + Shell + Add project.
 * - Project node: Agent + Shell + Add branch.
 * - Branch node: Agent + Shell only.
 *
 * The spawn options are INSTANT: picking Agent or Shell closes the palette on
 * the spot and spawns that agent type into a fresh workspace at the node's
 * scope — no "New terminal" phase, no agent-type dropdown, no prompt form
 * (the prompt is typed in the pane the agent opens in). The options come from
 * `PICKABLE_AGENT_TYPES`, so the palette is registry-driven: a hardcoded list
 * here is what silently dropped `pagespace` from a picker once. Only the
 * structural actions (Add project/Add branch) keep a second form phase,
 * mirroring {@link QuickCreatePalette}'s CommandDialog/back-button shape.
 *
 * The spawn options only appear when `onWorkspaceCreated` is passed — the
 * Diff/Files tabs render the shared {@link MachineTree} BARE, with no
 * workspace concept at all, and must not pay for one. Their hooks live in
 * {@link InstantSpawnGroup}, mounted only inside the OPEN dialog (Radix
 * unmounts closed dialog content), so `useAgentTerminals`/the workspace store
 * are never subscribed to for a row whose palette isn't showing.
 */

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Bot, ChevronDown, FolderGit2, Github, GitBranch, Plus, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useGithubRepos, type GithubRepo } from '@/hooks/useGithubRepos';
import { useProviders } from '@/hooks/useIntegrations';
import { useAgentTerminals } from '@/hooks/useAgentTerminals';
import { useSyncedWorkspaceActions } from '@/hooks/useMachineWorkspaceSync';
import { ConnectIntegrationDialog } from '@/components/integrations/ConnectIntegrationDialog';
import { normalizeProjectName } from '@pagespace/lib/services/machines/project-name';
import { normalizeBranchName } from '@pagespace/lib/services/machines/branch-name';
import {
  PICKABLE_AGENT_TYPES,
  agentSurfaceOf,
  isAgentRuntimeType,
  type AgentRuntimeType,
} from '@pagespace/lib/services/machines/agent-terminal-types';
import { autoSessionName, sessionWorkspaceId } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { AddButton } from './RemoveButton';
import { nodeScopeOf } from './WorkspaceLeaves';
import { agentTypeLabelOf } from './pane-surface';
import type { MachineTreeNode } from './MachineTree';

/** Short project name from a GitHub `full_name` (e.g. "org/my-repo" -> "my-repo"), and the ready-to-clone URL. */
export function deriveProjectFieldsFromRepo(repo: { full_name: string; clone_url: string }): { name: string; repoUrl: string } {
  const segments = repo.full_name.split('/');
  return { name: segments[segments.length - 1] || repo.full_name, repoUrl: repo.clone_url };
}

/** Spawn is one act, so the session name is minted rather than asked for — same reasoning as TerminalPanes' split-and-pick. */
function freshNameSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** The actions that still need a form phase — spawns are instant, not phases. */
type StructuralAction = 'add-project' | 'add-branch';
type Phase = 'select' | StructuralAction;

const ACTION_LABEL: Record<StructuralAction, string> = {
  'add-project': 'Add project',
  'add-branch': 'Add branch',
};

function structuralActionsFor(node: MachineTreeNode): StructuralAction[] {
  const actions: StructuralAction[] = [];
  if (node.level === 'machine') actions.push('add-project');
  if (node.level === 'project') actions.push('add-branch');
  return actions;
}

/** What the user's raw input will actually be saved as, shown live as they
 * type — the client-side half of "normalize-and-accept": `normalize` never
 * rejects, so this is purely informational and never blocks submission. */
function NamePreview({ value, normalize }: { value: string; normalize(input: string): string }) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = normalize(trimmed);
  if (normalized === trimmed) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Will be saved as <span className="font-mono">{normalized}</span>
    </p>
  );
}

function PhaseHeader({ title, onBack }: { title: string; onBack(): void }) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2.5">
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Back to actions"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}

export interface NodeActionPaletteProps {
  machineId: string;
  node: MachineTreeNode;
  /** Only offered at the machine node. */
  onAddProject?(name: string, repoUrl: string): Promise<unknown>;
  /** Only offered at project nodes. */
  onAddBranch?(branchName: string): Promise<unknown>;
  /** When provided, offers "New terminal" at every level — spawns an agent
   * into a freshly created workspace at this node's scope and reports its
   * id. Omitted by the Diff/Files tabs (bare trees, no workspace concept). */
  onWorkspaceCreated?(workspaceId: string): void;
}

/** The row's single hover-revealed "+" and the context-aware palette it opens. */
export default function NodeActionPalette({ machineId, node, onAddProject, onAddBranch, onWorkspaceCreated }: NodeActionPaletteProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('select');

  const structuralActions = structuralActionsFor(node);
  if (structuralActions.length === 0 && onWorkspaceCreated === undefined) return null;

  const reset = () => setPhase('select');
  // Also resets the phase: this is called on SUCCESS (a spawn/add completing),
  // not via Radix's onOpenChange — setting `open` false ourselves doesn't fire
  // that callback, so without resetting here too, the palette would reopen
  // straight back into the just-completed action's form instead of the list.
  const close = () => { setOpen(false); reset(); };

  return (
    <>
      <AddButton onClick={() => setOpen(true)} label="Add…" icon={<Plus className="mx-auto size-3" />} />

      {phase === 'select' && (
        <CommandDialog
          open={open}
          onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}
          title="Add…"
          description="Choose an action"
          showCloseButton={false}
          className="max-w-[380px]"
        >
          <CommandInput placeholder="Search actions…" autoFocus />
          <CommandList>
            <CommandEmpty>No matching actions.</CommandEmpty>
            {onWorkspaceCreated !== undefined && (
              <InstantSpawnGroup
                machineId={machineId}
                node={node}
                onClose={close}
                onSpawned={onWorkspaceCreated}
              />
            )}
            {structuralActions.length > 0 && (
              <CommandGroup>
                {structuralActions.map((action) => (
                  <CommandItem key={action} value={ACTION_LABEL[action]} onSelect={() => setPhase(action)}>
                    {action === 'add-project' && <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />}
                    {action === 'add-branch' && <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />}
                    {ACTION_LABEL[action]}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </CommandDialog>
      )}

      {phase === 'add-project' && onAddProject && (
        <CommandDialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }} title="Add project" description="Clone a git repo" showCloseButton={false} className="max-w-[380px]">
          <AddProjectForm onAdd={onAddProject} onBack={reset} onDone={close} />
        </CommandDialog>
      )}

      {phase === 'add-branch' && onAddBranch && (
        <CommandDialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }} title="Add branch" description="Check out a branch" showCloseButton={false} className="max-w-[380px]">
          <AddBranchForm onAdd={onAddBranch} onBack={reset} onDone={close} />
        </CommandDialog>
      )}
    </>
  );
}

/**
 * The palette's instant-spawn options — split-and-pick retargeted at a fresh
 * workspace, with the pick collapsed into the palette itself: clicking Agent
 * or Shell closes the palette on the spot and spawns that type into a new
 * workspace at the node's scope. Mirrors TerminalPanes' `spawnIntoPane`
 * closely — same upsert/`resumed` handling, same "only clean up what we
 * created" guard — but there is no pane to pick INTO: the palette click IS the
 * "give me an agent" click, so the session gets its OWN workspace.
 *
 * That workspace is materialized by `openTerminal`, not by a create-then-bind
 * pair. Create-then-bind published an EMPTY workspace first and bound it in a
 * second, unordered write; when those two echoes reordered, the bind was lost
 * and one spawned agent showed up as an empty "Workspace N" row PLUS an
 * unclaimed session row — and clicking that row minted a THIRD artifact. Since
 * `openTerminal` derives the workspace id from the session
 * (`sessionWorkspaceId`) and pushes ONE already-bound snapshot, there is no
 * empty intermediate state to echo and the adopt-click lands on the SAME id it
 * already has — the "second workspace" failure is structurally impossible, not
 * merely raced-away. A resumed session that is already on screen dedups for
 * free via `openTerminal`'s own `workspaceShowing` lookup.
 *
 * DELIBERATE PRODUCT CHANGE: the sidebar row is therefore named after the
 * session (`pagespace-…`) rather than "Workspace N". That matches the approved
 * design canvas (session-named leaves) and removes the dual-naming confusion
 * the field report described; rows stay renameable (double-click).
 *
 * This component (not the palette) owns the SWR/workspace hooks so the bare
 * Diff/Files trees never subscribe: it renders only when `onWorkspaceCreated`
 * exists, inside dialog content Radix unmounts while closed.
 *
 * The palette closes BEFORE the network resolves — the click is the
 * commitment, and the pane the caller navigates to on `onSpawned` is where
 * the result lands. The async continuation is unmount-safe: everything it
 * touches is closure-captured (store writes go through `getState`, the SWR
 * mutations are cache-addressed, `onSpawned` closes over the caller's stable
 * store actions). There is no cancel affordance mid-flight anymore, so the
 * old `cancelledRef` back-out went with the form it guarded.
 */
function InstantSpawnGroup({
  machineId,
  node,
  onClose,
  onSpawned,
}: {
  machineId: string;
  node: MachineTreeNode;
  onClose(): void;
  onSpawned(workspaceId: string): void;
}) {
  const scope = nodeScopeOf(node);
  const { addAgentTerminal, removeAgentTerminal } = useAgentTerminals(machineId, scope.projectName ?? null, scope.branchName ?? null);
  // Server-synced (#2048) — a workspace/pane created here must push to the
  // server like every other create/bind path, not just materialize locally.
  const { openTerminal } = useSyncedWorkspaceActions(machineId);

  const spawn = async (agentType: AgentRuntimeType) => {
    onClose();
    // May end up set even on a path that throws before assignment finishes —
    // tracked outside the try so the catch below knows whether there's a
    // session to clean up, regardless of which step failed.
    let created: Awaited<ReturnType<typeof addAgentTerminal>> | undefined;
    try {
      created = await addAgentTerminal(autoSessionName(agentType, freshNameSuffix()), agentType);

      const paneScope = {
        projectName: scope.projectName,
        branchName: scope.branchName,
        name: created.name,
        // Same rule as TerminalPanes' spawnIntoPane: record the surface at bind
        // time, judged by the API's answer (`created.agentType` — a resumed
        // session's type can differ from the picked one); only `chat` is
        // written, since an omitted kind already means `terminal` (see
        // OpenTerminalScope).
        ...(isAgentRuntimeType(created.agentType) && agentSurfaceOf(created.agentType) === 'chat'
          ? { kind: 'chat' as const }
          : {}),
      };

      // Born bound: one synchronous materialize-and-show, one already-bound
      // server push. No starting prompt — instant spawn means the prompt is
      // typed in the pane itself, so there is nothing to auto-send.
      openTerminal(paneScope);
      onSpawned(sessionWorkspaceId(paneScope));
    } catch (err) {
      // `created` may be set even though we're here (e.g. the store write
      // itself threw) — clean up a session that was made but never
      // successfully handed off.
      if (created && !created.resumed) {
        await removeAgentTerminal(created.name).catch(() => {});
      }
      toast.error(err instanceof Error ? err.message : 'Failed to spawn agent');
    }
  };

  return (
    <CommandGroup>
      {PICKABLE_AGENT_TYPES.map((type) => (
        <CommandItem key={type} value={agentTypeLabelOf(type)} onSelect={() => void spawn(type)}>
          {agentSurfaceOf(type) === 'chat' ? (
            <Bot className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {agentTypeLabelOf(type)}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function GithubRepoPicker({
  repos,
  isLoading,
  error,
  selectedLabel,
  onSelect,
}: {
  repos: GithubRepo[];
  isLoading: boolean;
  error?: Error;
  selectedLabel?: string;
  onSelect(repo: GithubRepo): void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={pickerOpen} className="w-full justify-between font-normal">
          <span className="flex min-w-0 items-center gap-2">
            <Github className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={cn('truncate', !selectedLabel && 'text-muted-foreground')}>
              {selectedLabel || 'Select a repo…'}
            </span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search your repos…" />
          <CommandList onWheel={(e) => e.stopPropagation()}>
            <CommandEmpty>
              {error ? `Failed to load repos: ${error.message}` : isLoading ? 'Loading repos…' : 'No repos found.'}
            </CommandEmpty>
            {repos.map((repo) => (
              <CommandItem key={repo.full_name} value={repo.full_name} onSelect={() => { onSelect(repo); setPickerOpen(false); }}>
                <FolderGit2 className="mr-2 size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">{repo.full_name}</span>
                {repo.private && (
                  <span className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">private</span>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AddProjectForm({
  onAdd,
  onBack,
  onDone,
}: {
  onAdd(name: string, repoUrl: string): Promise<unknown>;
  onBack(): void;
  onDone(): void;
}) {
  const pathname = usePathname();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);

  const { repos, connected, isLoading: reposLoading, error: reposError, mutate: refetchRepos } = useGithubRepos(!manualMode);
  const { providers } = useProviders(true);
  const githubProvider = providers.find((p) => p.slug === 'github') ?? null;

  const mode: 'manual' | 'connect' | 'picker' = manualMode ? 'manual' : connected === false ? 'connect' : 'picker';

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onAdd(name.trim(), repoUrl.trim());
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add project');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectRepo = (repo: GithubRepo) => {
    const fields = deriveProjectFieldsFromRepo(repo);
    setName(fields.name);
    setRepoUrl(fields.repoUrl);
  };

  return (
    <>
      <PhaseHeader title="Add project" onBack={onBack} />
      <div className="flex flex-col gap-3 px-4 py-4">
        <div>
          <Input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
          <NamePreview value={name} normalize={normalizeProjectName} />
        </div>

        {mode === 'manual' && (
          <Input placeholder="Repo URL (https://github.com/org/repo.git)" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
        )}
        {mode === 'connect' && (
          <Button type="button" variant="outline" onClick={() => setConnectDialogOpen(true)} className="justify-start gap-2 font-normal text-muted-foreground">
            <Github className="size-3.5 shrink-0" />
            Connect GitHub to browse your repos
          </Button>
        )}
        {mode === 'picker' && (
          <GithubRepoPicker repos={repos} isLoading={reposLoading} error={reposError} selectedLabel={name} onSelect={handleSelectRepo} />
        )}

        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto justify-start p-0 text-xs text-muted-foreground"
          onClick={() => setManualMode((m) => !m)}
        >
          {manualMode ? 'Pick from your GitHub repos instead' : 'Enter a repo URL manually'}
        </Button>

        <div className="flex justify-end">
          <Button onClick={() => void handleSubmit()} disabled={submitting || !name.trim() || !repoUrl.trim()} className="h-7 px-3 text-xs">
            {submitting ? 'Adding…' : 'Add project'}
          </Button>
        </div>
      </div>
      <ConnectIntegrationDialog
        provider={githubProvider}
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
        onConnected={() => {
          setConnectDialogOpen(false);
          refetchRepos();
        }}
        returnUrl={pathname}
      />
    </>
  );
}

function AddBranchForm({
  onAdd,
  onBack,
  onDone,
}: {
  onAdd(branchName: string): Promise<unknown>;
  onBack(): void;
  onDone(): void;
}) {
  const [branchName, setBranchName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onAdd(branchName.trim());
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add branch');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PhaseHeader title="Add branch" onBack={onBack} />
      <div className="flex flex-col gap-3 px-4 py-4">
        <div>
          <Input
            placeholder="Branch name"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !submitting && branchName.trim()) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          />
          <NamePreview value={branchName} normalize={normalizeBranchName} />
        </div>
        <div className="flex justify-end">
          <Button onClick={() => void handleSubmit()} disabled={submitting || !branchName.trim()} className="h-7 px-3 text-xs">
            {submitting ? 'Spawning…' : 'Add branch'}
          </Button>
        </div>
      </div>
    </>
  );
}

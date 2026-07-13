"use client";

/**
 * The single "+" per Machine/Project/Branch row (Terminal UX redesign,
 * add-palette consolidation). Before this, a row could carry up to TWO plus
 * icons that did different things — the structural "Add project"/"Add branch"
 * dialog trigger (this file's predecessor lived in MachineTree.tsx) and the
 * separate "New workspace" trigger injected via `renderNodeExtra`
 * (WorkspaceLeaves.tsx's `WorkspaceNodeExtras`). One `+` per row, one
 * Raycast-style palette, actions scoped to what that node can actually do:
 *
 * - Machine node: New terminal + Add project.
 * - Project node: New terminal + Add branch.
 * - Branch node: New terminal only.
 *
 * "New terminal" only appears when `onWorkspaceCreated` is passed — the
 * Diff/Files tabs render the shared {@link MachineTree} BARE, with no
 * workspace concept at all, and must not pay for one. Its spawn step
 * (`TerminalSpawnForm`) is its own component, mounted only once the user
 * actually opens that phase, so `useAgentTerminals`/the workspace store are
 * never subscribed to for a row that only ever shows Add project/Add branch.
 *
 * Two-phase flow mirrors {@link QuickCreatePalette}: pick the action, then
 * fill in its details. Follows that file's CommandDialog/back-button/phase
 * shape closely rather than inventing a new palette pattern.
 */

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, ChevronDown, FolderGit2, Github, GitBranch, Plus, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { ConnectIntegrationDialog } from '@/components/integrations/ConnectIntegrationDialog';
import { normalizeProjectName } from '@pagespace/lib/services/machines/project-name';
import { normalizeBranchName } from '@pagespace/lib/services/machines/branch-name';
import type { AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import { useMachineWorkspaceStore, autoSessionName } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { AddButton } from './RemoveButton';
import { nodeScopeOf } from './WorkspaceLeaves';
import type { MachineTreeNode } from './MachineTree';

/**
 * The "New terminal" agent choices — a fixed, local list rather than
 * `Object.keys(AGENT_LAUNCH_SPECS)`, for two reasons: `pagespace-cli` is
 * being removed as an agent type by a sibling change, and `shell` must be
 * offered and listed FIRST (a plain shell is a first-class choice here,
 * arguably the default — not an afterthought). Defined locally so this
 * palette can't silently inherit some other list that (buggily) excludes it.
 */
const PICKABLE_AGENT_TYPES: AgentRuntimeType[] = ['shell', 'claude', 'codex'];

/** Short project name from a GitHub `full_name` (e.g. "org/my-repo" -> "my-repo"), and the ready-to-clone URL. */
export function deriveProjectFieldsFromRepo(repo: { full_name: string; clone_url: string }): { name: string; repoUrl: string } {
  const segments = repo.full_name.split('/');
  return { name: segments[segments.length - 1] || repo.full_name, repoUrl: repo.clone_url };
}

/** Spawn is one act, so the session name is minted rather than asked for — same reasoning as TerminalPanes' split-and-pick. */
function freshNameSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

type PaletteAction = 'new-terminal' | 'add-project' | 'add-branch';
type Phase = 'select' | PaletteAction;

const ACTION_LABEL: Record<PaletteAction, string> = {
  'new-terminal': 'New terminal',
  'add-project': 'Add project',
  'add-branch': 'Add branch',
};

function actionsFor(node: MachineTreeNode, hasTerminalSupport: boolean): PaletteAction[] {
  const actions: PaletteAction[] = [];
  if (hasTerminalSupport) actions.push('new-terminal');
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

  const actions = actionsFor(node, onWorkspaceCreated !== undefined);
  if (actions.length === 0) return null;

  const close = () => setOpen(false);
  const reset = () => setPhase('select');

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
            <CommandGroup>
              {actions.map((action) => (
                <CommandItem key={action} value={ACTION_LABEL[action]} onSelect={() => setPhase(action)}>
                  {action === 'new-terminal' && <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />}
                  {action === 'add-project' && <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />}
                  {action === 'add-branch' && <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />}
                  {ACTION_LABEL[action]}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </CommandDialog>
      )}

      {phase === 'new-terminal' && onWorkspaceCreated && (
        <CommandDialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }} title="New terminal" description="Spawn an agent" showCloseButton={false} className="max-w-[380px]">
          <TerminalSpawnForm
            machineId={machineId}
            node={node}
            onBack={reset}
            onSpawned={(workspaceId) => {
              close();
              onWorkspaceCreated(workspaceId);
            }}
          />
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
 * Split-and-pick, retargeted at a fresh workspace instead of an existing
 * empty pane: create the session AND place it, in one act. Mirrors
 * TerminalPanes' `spawnIntoPane` closely — same upsert/`resumed` handling,
 * same "only clean up what we created" guard — but binds into the new
 * workspace's first pane rather than a pane the user picked by clicking into
 * it, since there is no pane yet: the palette action IS the "give me an
 * agent" click.
 */
function TerminalSpawnForm({
  machineId,
  node,
  onSpawned,
  onBack,
}: {
  machineId: string;
  node: MachineTreeNode;
  onSpawned(workspaceId: string): void;
  onBack(): void;
}) {
  const scope = nodeScopeOf(node);
  const { addAgentTerminal, removeAgentTerminal } = useAgentTerminals(machineId, scope.projectName ?? null, scope.branchName ?? null);
  const createWorkspace = useMachineWorkspaceStore((state) => state.createWorkspace);
  const bindPaneTerminal = useMachineWorkspaceStore((state) => state.bindPaneTerminal);

  const [agentType, setAgentType] = useState<AgentRuntimeType>(PICKABLE_AGENT_TYPES[0]);
  const [prompt, setPrompt] = useState('');
  const [spawning, setSpawning] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => promptRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  const submit = async () => {
    setSpawning(true);
    try {
      const created = await addAgentTerminal(autoSessionName(agentType, freshNameSuffix()), agentType);
      const workspaceId = createWorkspace(machineId, scope);
      const workspace = useMachineWorkspaceStore.getState().machines[machineId]?.workspaces[workspaceId];
      const bound = workspace
        ? bindPaneTerminal(
            machineId,
            workspaceId,
            workspace.activePaneId,
            { projectName: scope.projectName, branchName: scope.branchName, name: created.name },
            created.resumed ? undefined : prompt.trim() || undefined,
          )
        : false;
      if (!bound && !created.resumed) {
        await removeAgentTerminal(created.name).catch(() => {});
      }
      onSpawned(workspaceId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to spawn agent');
      setSpawning(false);
    }
  };

  return (
    <>
      <PhaseHeader title="New terminal" onBack={onBack} />
      <div className="flex flex-col gap-3 px-4 py-4">
        <Select value={agentType} onValueChange={(value) => setAgentType(value as AgentRuntimeType)}>
          <SelectTrigger aria-label="Agent type" className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PICKABLE_AGENT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Starting prompt (optional)"
          aria-label="Starting prompt"
          rows={2}
          className="resize-none text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!spawning) void submit();
            }
          }}
        />
        <div className="flex justify-end">
          <Button size="sm" disabled={spawning} onClick={() => void submit()} className="h-7 px-3 text-xs">
            {spawning ? 'Spawning…' : 'Spawn agent'}
          </Button>
        </div>
      </div>
    </>
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

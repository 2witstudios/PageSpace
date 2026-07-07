"use client";

import { useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronRight,
  ChevronDown,
  Cpu,
  FolderGit2,
  Github,
  GitBranch,
  TerminalSquare,
  Plus,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useMachineProjects } from '@/hooks/useMachineProjects';
import { useMachineBranches } from '@/hooks/useMachineBranches';
import { useAgentTerminals, type AgentTerminal } from '@/hooks/useAgentTerminals';
import { useGithubRepos, type GithubRepo } from '@/hooks/useGithubRepos';
import { useProviders } from '@/hooks/useIntegrations';
import { ConnectIntegrationDialog } from '@/components/integrations/ConnectIntegrationDialog';
import { AGENT_LAUNCH_SPECS, type AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import EmptyState from './EmptyState';

const AGENT_TYPES = Object.keys(AGENT_LAUNCH_SPECS) as AgentRuntimeType[];

/** Short project name from a GitHub `full_name` (e.g. "org/my-repo" -> "my-repo"), and the ready-to-clone URL. */
export function deriveProjectFieldsFromRepo(repo: { full_name: string; clone_url: string }): { name: string; repoUrl: string } {
  const segments = repo.full_name.split('/');
  return { name: segments[segments.length - 1] || repo.full_name, repoUrl: repo.clone_url };
}

/** Identifies which terminal to open in the middle panel — neither `projectName` nor `branchName` set is machine scope, `projectName` alone is project scope, both is branch scope. */
export interface OpenTerminalScope {
  projectName?: string;
  branchName?: string;
  name: string;
}

interface NavigatorProps {
  terminalId: string;
  onOpenTerminal(scope: OpenTerminalScope): void;
}

export default function Navigator({ terminalId, onOpenTerminal }: NavigatorProps) {
  return (
    <div className="flex h-full flex-col border-l">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Navigator</span>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-1 text-sm">
          <MachineNode terminalId={terminalId} onOpenTerminal={onOpenTerminal} />
        </div>
      </ScrollArea>
    </div>
  );
}

function MachineNode({ terminalId, onOpenTerminal }: { terminalId: string; onOpenTerminal(scope: OpenTerminalScope): void }) {
  const [expanded, setExpanded] = useState(true);
  const {
    agentTerminals,
    isLoading: terminalsLoading,
    addAgentTerminal,
    removeAgentTerminal,
  } = useAgentTerminals(expanded ? terminalId : null, null, null);
  const {
    projects,
    isLoading: projectsLoading,
    addProject,
    removeProject,
  } = useMachineProjects(expanded ? terminalId : null);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-1 rounded-sm py-1 pr-1 text-left hover:bg-accent/50"
      >
        {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Cpu className="size-3.5 shrink-0" />
        <span className="truncate font-medium">Machine</span>
      </button>
      {expanded && (
        <div className="pl-4">
          <TerminalList
            terminals={agentTerminals}
            isLoading={terminalsLoading}
            emptyLabel="No terminals yet"
            onAdd={addAgentTerminal}
            onRemove={removeAgentTerminal}
            onOpen={(name) => onOpenTerminal({ name })}
          />
          <div className="mt-1 flex items-center justify-between py-0.5 pr-1">
            <span className="text-xs text-muted-foreground">Projects</span>
            <AddProjectDialog onAdd={addProject} />
          </div>
          {projectsLoading && <div className="px-2 py-1 text-xs text-muted-foreground">Loading projects…</div>}
          {!projectsLoading && projects.length === 0 && (
            <EmptyState
              title="No projects yet"
              description="Add a git repo to this machine to start a branch-terminal."
            >
              <AddProjectDialog onAdd={addProject} triggerLabel="Add your first project" />
            </EmptyState>
          )}
          {projects.map((project) => (
            <ProjectNode
              key={project.name}
              terminalId={terminalId}
              projectName={project.name}
              onOpenTerminal={onOpenTerminal}
              onRemoveProject={() => removeProject(project.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectNode({
  terminalId,
  projectName,
  onOpenTerminal,
  onRemoveProject,
}: {
  terminalId: string;
  projectName: string;
  onOpenTerminal(scope: OpenTerminalScope): void;
  onRemoveProject(): Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const {
    agentTerminals,
    isLoading: terminalsLoading,
    addAgentTerminal,
    removeAgentTerminal,
  } = useAgentTerminals(expanded ? terminalId : null, projectName, null);
  const {
    branches,
    isLoading: branchesLoading,
    addBranch,
    removeBranch,
  } = useMachineBranches(expanded ? terminalId : null, projectName);

  return (
    <div>
      <div className="group flex items-center gap-1 rounded-sm py-1 pr-1 hover:bg-accent/50">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex flex-1 items-center gap-1 text-left"
        >
          {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          <FolderGit2 className="size-3.5 shrink-0" />
          <span className="truncate font-medium">{projectName}</span>
        </button>
        <button
          type="button"
          onClick={() => setConfirmingRemove(true)}
          className="invisible size-5 shrink-0 rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:visible"
          title="Remove project"
        >
          <X className="mx-auto size-3.5" />
        </button>
      </div>
      <ConfirmRemoveDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Remove project?"
        description={`Remove project "${projectName}"? This does not touch its branch-terminals.`}
        onConfirm={onRemoveProject}
      />
      {expanded && (
        <div className="pl-4">
          <TerminalList
            terminals={agentTerminals}
            isLoading={terminalsLoading}
            emptyLabel="No terminals yet"
            onAdd={addAgentTerminal}
            onRemove={removeAgentTerminal}
            onOpen={(name) => onOpenTerminal({ projectName, name })}
          />
          <div className="mt-1 flex items-center justify-between py-0.5 pr-1">
            <span className="text-xs text-muted-foreground">Branches</span>
            <AddBranchDialog onAdd={addBranch} />
          </div>
          {branchesLoading && <div className="px-2 py-1 text-xs text-muted-foreground">Loading branches…</div>}
          {!branchesLoading && branches.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">No branches yet</div>
          )}
          {branches.map((branch) => (
            <BranchNode
              key={branch.branchName}
              terminalId={terminalId}
              projectName={projectName}
              branchName={branch.branchName}
              onOpenTerminal={onOpenTerminal}
              onRemoveBranch={() => removeBranch(branch.branchName)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BranchNode({
  terminalId,
  projectName,
  branchName,
  onOpenTerminal,
  onRemoveBranch,
}: {
  terminalId: string;
  projectName: string;
  branchName: string;
  onOpenTerminal(scope: OpenTerminalScope): void;
  onRemoveBranch(): Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const {
    agentTerminals,
    isLoading: terminalsLoading,
    addAgentTerminal,
    removeAgentTerminal,
  } = useAgentTerminals(expanded ? terminalId : null, projectName, branchName);

  return (
    <div>
      <div className="group flex items-center gap-1 rounded-sm py-1 pr-1 hover:bg-accent/50">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex flex-1 items-center gap-1 text-left"
        >
          {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">{branchName}</span>
        </button>
        <button
          type="button"
          onClick={() => setConfirmingRemove(true)}
          className="invisible size-5 shrink-0 rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:visible"
          title="Remove branch-terminal"
        >
          <X className="mx-auto size-3.5" />
        </button>
      </div>
      <ConfirmRemoveDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Remove branch-terminal?"
        description={`Remove branch-terminal "${branchName}"? Its Sprite will be destroyed.`}
        onConfirm={onRemoveBranch}
      />
      {expanded && (
        <div className="pl-4">
          <TerminalList
            terminals={agentTerminals}
            isLoading={terminalsLoading}
            emptyLabel="No terminals yet"
            onAdd={addAgentTerminal}
            onRemove={removeAgentTerminal}
            onOpen={(name) => onOpenTerminal({ projectName, branchName, name })}
          />
        </div>
      )}
    </div>
  );
}

function TerminalList({
  terminals,
  isLoading,
  emptyLabel,
  onAdd,
  onRemove,
  onOpen,
}: {
  terminals: AgentTerminal[];
  isLoading: boolean;
  emptyLabel: string;
  onAdd(name: string, agentType: AgentRuntimeType): Promise<unknown>;
  onRemove(name: string): Promise<unknown>;
  onOpen(name: string): void;
}) {
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  return (
    <div>
      <div className="flex items-center justify-between py-0.5 pr-1">
        <span className="text-xs text-muted-foreground">Terminals</span>
        <AddAgentTerminalDialog onAdd={onAdd} />
      </div>
      {isLoading && <div className="px-2 py-1 text-xs text-muted-foreground">Loading terminals…</div>}
      {!isLoading && terminals.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">{emptyLabel}</div>}
      {terminals.map((terminal) => (
        <div key={terminal.name} className="group flex items-center gap-1 rounded-sm py-1 pr-1 hover:bg-accent/50">
          <button
            type="button"
            onClick={() => onOpen(terminal.name)}
            className="flex flex-1 items-center gap-1 text-left"
          >
            <TerminalSquare className="size-3.5 shrink-0" />
            <span className="truncate">{terminal.name}</span>
            <span className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {terminal.agentType}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setPendingRemove(terminal.name)}
            className="invisible size-5 shrink-0 rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:visible"
            title="Remove terminal"
          >
            <X className="mx-auto size-3.5" />
          </button>
        </div>
      ))}
      <ConfirmRemoveDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        title="Remove terminal?"
        description={pendingRemove ? `Remove terminal "${pendingRemove}"?` : ''}
        onConfirm={() => {
          if (pendingRemove === null) return Promise.resolve();
          return onRemove(pendingRemove);
        }}
      />
    </div>
  );
}

function ConfirmRemoveDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  onConfirm(): Promise<unknown>;
}) {
  const [removing, setRemoving] = useState(false);

  const handleConfirm = async () => {
    setRemoving(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(v) => !removing && onOpenChange(v)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={removing}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {removing ? 'Removing…' : 'Remove'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function GithubRepoPicker({ repos, isLoading, onSelect }: { repos: GithubRepo[]; isLoading: boolean; onSelect(repo: GithubRepo): void }) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={pickerOpen} className="w-full justify-between font-normal">
          <span className="flex items-center gap-2 text-muted-foreground">
            <Github className="size-3.5 shrink-0" />
            Select a repo…
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search your repos…" />
          <CommandList onWheel={(e) => e.stopPropagation()}>
            <CommandEmpty>{isLoading ? 'Loading repos…' : 'No repos found.'}</CommandEmpty>
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

function AddProjectDialog({ onAdd, triggerLabel }: { onAdd(name: string, repoUrl: string): Promise<unknown>; triggerLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);

  const { repos, connected, isLoading: reposLoading } = useGithubRepos(open && !manualMode);
  const { providers } = useProviders();
  const githubProvider = providers.find((p) => p.slug === 'github') ?? null;

  const resetAndClose = () => {
    setOpen(false);
    setName('');
    setRepoUrl('');
    setManualMode(false);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onAdd(name.trim(), repoUrl.trim());
      resetAndClose();
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
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetAndClose(); }}>
      <DialogTrigger asChild>
        {triggerLabel ? (
          <Button variant="outline" size="sm" className="h-7 text-xs">
            {triggerLabel}
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="size-6" title="Add project">
            <Plus className="size-3.5" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>Clone a git repo onto this machine&apos;s persistent filesystem.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />

          {manualMode ? (
            <Input placeholder="Repo URL (https://github.com/org/repo.git)" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
          ) : connected === false ? (
            <Button type="button" variant="outline" onClick={() => setConnectDialogOpen(true)} className="justify-start gap-2 font-normal text-muted-foreground">
              <Github className="size-3.5 shrink-0" />
              Connect GitHub to browse your repos
            </Button>
          ) : (
            <GithubRepoPicker repos={repos} isLoading={reposLoading} onSelect={handleSelectRepo} />
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
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={submitting || !name.trim() || !repoUrl.trim()}>
            {submitting ? 'Adding…' : 'Add project'}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConnectIntegrationDialog
        provider={githubProvider}
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
        onConnected={() => setConnectDialogOpen(false)}
      />
    </Dialog>
  );
}

function AddBranchDialog({ onAdd }: { onAdd(branchName: string): Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onAdd(branchName.trim());
      setOpen(false);
      setBranchName('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add branch');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-5" title="Add branch-terminal">
          <Plus className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add branch-terminal</DialogTitle>
          <DialogDescription>Checks out this branch in its own isolated Sprite.</DialogDescription>
        </DialogHeader>
        <Input placeholder="Branch name" value={branchName} onChange={(e) => setBranchName(e.target.value)} />
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={submitting || !branchName.trim()}>
            {submitting ? 'Spawning…' : 'Add branch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddAgentTerminalDialog({ onAdd }: { onAdd(name: string, agentType: AgentRuntimeType): Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [agentType, setAgentType] = useState<AgentRuntimeType>(AGENT_TYPES[0]);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onAdd(name.trim(), agentType);
      setOpen(false);
      setName('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add terminal');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-5" title="Add terminal">
          <Plus className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add terminal</DialogTitle>
          <DialogDescription>Named PTY session running a pluggable agent type at this node&apos;s scope.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input placeholder="Terminal name" value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={agentType} onValueChange={(value) => setAgentType(value as AgentRuntimeType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={submitting || !name.trim()}>
            {submitting ? 'Adding…' : 'Add terminal'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronRight,
  ChevronDown,
  FolderGit2,
  GitBranch,
  TerminalSquare,
  Plus,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import { useMachineProjects } from '@/hooks/useMachineProjects';
import { useMachineBranches } from '@/hooks/useMachineBranches';
import { useAgentTerminals } from '@/hooks/useAgentTerminals';
import { AGENT_LAUNCH_SPECS, type AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import EmptyState from './EmptyState';

const AGENT_TYPES = Object.keys(AGENT_LAUNCH_SPECS) as AgentRuntimeType[];

interface NavigatorProps {
  terminalId: string;
  selectedProject: string | null;
  selectedBranch: string | null;
  onSelectProject(name: string): void;
  onSelectBranch(name: string): void;
  onOpenTerminal(name: string): void;
}

export default function Navigator({
  terminalId,
  selectedProject,
  selectedBranch,
  onSelectProject,
  onSelectBranch,
  onOpenTerminal,
}: NavigatorProps) {
  const { projects, isLoading, addProject, removeProject } = useMachineProjects(terminalId);

  return (
    <div className="flex h-full flex-col border-l">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Navigator</span>
        <AddProjectDialog onAdd={addProject} />
      </div>
      <ScrollArea className="flex-1">
        <div className="p-1 text-sm">
          {isLoading && <div className="px-2 py-1 text-xs text-muted-foreground">Loading projects…</div>}
          {!isLoading && projects.length === 0 && (
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
              selectedProject={selectedProject}
              selectedBranch={selectedBranch}
              onSelectProject={onSelectProject}
              onSelectBranch={onSelectBranch}
              onOpenTerminal={onOpenTerminal}
              onRemoveProject={() => {
                if (!window.confirm(`Remove project "${project.name}"? This does not touch its branch-terminals.`)) return;
                void removeProject(project.name).catch((err) => toast.error(err instanceof Error ? err.message : 'Failed to remove project'));
              }}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function ProjectNode({
  terminalId,
  projectName,
  selectedProject,
  selectedBranch,
  onSelectProject,
  onSelectBranch,
  onOpenTerminal,
  onRemoveProject,
}: {
  terminalId: string;
  projectName: string;
  selectedProject: string | null;
  selectedBranch: string | null;
  onSelectProject(name: string): void;
  onSelectBranch(name: string): void;
  onOpenTerminal(name: string): void;
  onRemoveProject(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isSelected = selectedProject === projectName;
  const { branches, addBranch, removeBranch } = useMachineBranches(terminalId, expanded ? projectName : null);

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-sm py-1 pr-1 ${isSelected ? 'bg-accent' : 'hover:bg-accent/50'}`}
      >
        <button
          type="button"
          onClick={() => {
            setExpanded((e) => !e);
            onSelectProject(projectName);
          }}
          className="flex flex-1 items-center gap-1 text-left"
        >
          {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          <FolderGit2 className="size-3.5 shrink-0" />
          <span className="truncate font-medium">{projectName}</span>
        </button>
        <button
          type="button"
          onClick={onRemoveProject}
          className="invisible size-5 shrink-0 rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:visible"
          title="Remove project"
        >
          <X className="mx-auto size-3.5" />
        </button>
      </div>
      {expanded && (
        <div className="pl-4">
          <div className="flex items-center justify-between py-0.5 pr-1">
            <span className="text-xs text-muted-foreground">Branches</span>
            <AddBranchDialog onAdd={addBranch} />
          </div>
          {branches.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">No branches yet</div>}
          {branches.map((branch) => (
            <BranchNode
              key={branch.branchName}
              terminalId={terminalId}
              projectName={projectName}
              branchName={branch.branchName}
              selectedBranch={selectedBranch}
              onSelectBranch={onSelectBranch}
              onOpenTerminal={onOpenTerminal}
              onRemoveBranch={() => {
                if (!window.confirm(`Remove branch-terminal "${branch.branchName}"? Its Sprite will be destroyed.`)) return;
                void removeBranch(branch.branchName).catch((err) =>
                  toast.error(err instanceof Error ? err.message : 'Failed to remove branch'),
                );
              }}
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
  selectedBranch,
  onSelectBranch,
  onOpenTerminal,
  onRemoveBranch,
}: {
  terminalId: string;
  projectName: string;
  branchName: string;
  selectedBranch: string | null;
  onSelectBranch(name: string): void;
  onOpenTerminal(name: string): void;
  onRemoveBranch(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isSelected = selectedBranch === branchName;
  const { agentTerminals, addAgentTerminal, removeAgentTerminal } = useAgentTerminals(
    terminalId,
    projectName,
    expanded ? branchName : null,
  );

  return (
    <div>
      <div className={`group flex items-center gap-1 rounded-sm py-1 pr-1 ${isSelected ? 'bg-accent' : 'hover:bg-accent/50'}`}>
        <button
          type="button"
          onClick={() => {
            setExpanded((e) => !e);
            onSelectBranch(branchName);
          }}
          className="flex flex-1 items-center gap-1 text-left"
        >
          {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">{branchName}</span>
        </button>
        <button
          type="button"
          onClick={onRemoveBranch}
          className="invisible size-5 shrink-0 rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:visible"
          title="Remove branch-terminal"
        >
          <X className="mx-auto size-3.5" />
        </button>
      </div>
      {expanded && (
        <div className="pl-4">
          <div className="flex items-center justify-between py-0.5 pr-1">
            <span className="text-xs text-muted-foreground">Terminals</span>
            <AddAgentTerminalDialog onAdd={addAgentTerminal} />
          </div>
          {agentTerminals.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">No terminals yet</div>}
          {agentTerminals.map((terminal) => (
            <div
              key={terminal.name}
              className="group flex items-center gap-1 rounded-sm py-1 pr-1 hover:bg-accent/50"
            >
              <button
                type="button"
                onClick={() => onOpenTerminal(terminal.name)}
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
                onClick={() => {
                  if (!window.confirm(`Remove terminal "${terminal.name}"?`)) return;
                  void removeAgentTerminal(terminal.name).catch((err) =>
                    toast.error(err instanceof Error ? err.message : 'Failed to remove terminal'),
                  );
                }}
                className="invisible size-5 shrink-0 rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:visible"
                title="Remove terminal"
              >
                <X className="mx-auto size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddProjectDialog({ onAdd, triggerLabel }: { onAdd(name: string, repoUrl: string): Promise<unknown>; triggerLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onAdd(name.trim(), repoUrl.trim());
      setOpen(false);
      setName('');
      setRepoUrl('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add project');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
          <Input placeholder="Repo URL (https://github.com/org/repo.git)" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={submitting || !name.trim() || !repoUrl.trim()}>
            {submitting ? 'Adding…' : 'Add project'}
          </Button>
        </DialogFooter>
      </DialogContent>
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
          <DialogDescription>Named PTY session inside this branch&apos;s Sprite, running a pluggable agent type.</DialogDescription>
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

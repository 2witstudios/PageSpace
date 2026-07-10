"use client";

import { useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  ChevronRight,
  ChevronDown,
  Cpu,
  FolderGit2,
  Github,
  GitBranch,
  Plus,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { useGithubRepos, type GithubRepo } from '@/hooks/useGithubRepos';
import { useProviders } from '@/hooks/useIntegrations';
import { ConnectIntegrationDialog } from '@/components/integrations/ConnectIntegrationDialog';
import EmptyState from './EmptyState';

/** A node in the Machine → Project → Branch tree, passed to `onSelectNode` and `renderNodeChildren`. */
export type MachineTreeNode =
  | { level: 'machine' }
  | { level: 'project'; projectName: string }
  | { level: 'branch'; projectName: string; branchName: string };

interface MachineTreeProps {
  terminalId: string;
  /** Called when a Machine/Project/Branch row is clicked. Omit if the tree itself isn't selectable (e.g. selection lives on injected leaf content instead). */
  onSelectNode?: (node: MachineTreeNode) => void;
  /** Renders caller-owned content under a node when it's expanded (e.g. session-terminal rows). Branch nodes are only expandable when this is provided — otherwise they render as a flat, non-expandable row. */
  renderNodeChildren?: (node: MachineTreeNode) => ReactNode;
}

/** Presentation-only Machine → Project → Branch tree, reusable across any tab that needs this navigation shape (Terminal, Diff, …). Has no opinion on what a row click does — callers own that via `onSelectNode`. */
export default function MachineTree({ terminalId, onSelectNode, renderNodeChildren }: MachineTreeProps) {
  return (
    <div className="p-1 text-sm">
      <MachineNode terminalId={terminalId} onSelectNode={onSelectNode} renderNodeChildren={renderNodeChildren} />
    </div>
  );
}

function TreeRow({
  expanded,
  onToggleExpand,
  onSelect,
  icon,
  label,
  labelClassName,
  onRemove,
  removeTitle,
}: {
  expanded?: boolean;
  onToggleExpand?(): void;
  onSelect?(): void;
  icon: ReactNode;
  label: string;
  labelClassName?: string;
  onRemove?(): void;
  removeTitle?: string;
}) {
  return (
    <div className="group flex items-center gap-1 rounded-sm py-1 pr-1 hover:bg-accent/50">
      {onToggleExpand ? (
        <button
          type="button"
          onClick={onToggleExpand}
          className="shrink-0 rounded-sm p-0.5 hover:bg-accent"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          data-testid="expand-chevron"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <button
        type="button"
        onClick={onSelect}
        disabled={!onSelect}
        className={cn('flex flex-1 items-center gap-1 text-left', !onSelect && 'cursor-default')}
      >
        {icon}
        <span className={cn('truncate', labelClassName)}>{label}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="invisible size-5 shrink-0 rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:visible"
          title={removeTitle}
        >
          <X className="mx-auto size-3.5" />
        </button>
      )}
    </div>
  );
}

interface TreeLevelProps {
  onSelectNode?: (node: MachineTreeNode) => void;
  renderNodeChildren?: (node: MachineTreeNode) => ReactNode;
}

function MachineNode({ terminalId, onSelectNode, renderNodeChildren }: TreeLevelProps & { terminalId: string }) {
  const [expanded, setExpanded] = useState(true);
  const node: MachineTreeNode = { level: 'machine' };
  const { projects, isLoading: projectsLoading, addProject, removeProject } = useMachineProjects(expanded ? terminalId : null);

  return (
    <div>
      <TreeRow
        expanded={expanded}
        onToggleExpand={() => setExpanded((e) => !e)}
        onSelect={onSelectNode ? () => onSelectNode(node) : undefined}
        icon={<Cpu className="size-3.5 shrink-0" />}
        label="Machine"
        labelClassName="font-medium"
      />
      {expanded && (
        <div className="pl-4">
          {renderNodeChildren?.(node)}
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
              onSelectNode={onSelectNode}
              renderNodeChildren={renderNodeChildren}
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
  onSelectNode,
  renderNodeChildren,
  onRemoveProject,
}: TreeLevelProps & {
  terminalId: string;
  projectName: string;
  onRemoveProject(): Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const node: MachineTreeNode = { level: 'project', projectName };
  const { branches, isLoading: branchesLoading, addBranch, removeBranch } = useMachineBranches(expanded ? terminalId : null, projectName);

  return (
    <div>
      <TreeRow
        expanded={expanded}
        onToggleExpand={() => setExpanded((e) => !e)}
        onSelect={onSelectNode ? () => onSelectNode(node) : undefined}
        icon={<FolderGit2 className="size-3.5 shrink-0" />}
        label={projectName}
        labelClassName="font-medium"
        onRemove={() => setConfirmingRemove(true)}
        removeTitle="Remove project"
      />
      <ConfirmRemoveDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Remove project?"
        description={`Remove project "${projectName}"? This does not touch its branch-terminals.`}
        onConfirm={onRemoveProject}
      />
      {expanded && (
        <div className="pl-4">
          {renderNodeChildren?.(node)}
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
              projectName={projectName}
              branchName={branch.branchName}
              onSelectNode={onSelectNode}
              renderNodeChildren={renderNodeChildren}
              onRemoveBranch={() => removeBranch(branch.branchName)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BranchNode({
  projectName,
  branchName,
  onSelectNode,
  renderNodeChildren,
  onRemoveBranch,
}: TreeLevelProps & {
  projectName: string;
  branchName: string;
  onRemoveBranch(): Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const node: MachineTreeNode = { level: 'branch', projectName, branchName };
  const expandable = renderNodeChildren !== undefined;

  return (
    <div>
      <TreeRow
        expanded={expandable ? expanded : undefined}
        onToggleExpand={expandable ? () => setExpanded((e) => !e) : undefined}
        onSelect={onSelectNode ? () => onSelectNode(node) : undefined}
        icon={<GitBranch className="size-3.5 shrink-0" />}
        label={branchName}
        onRemove={() => setConfirmingRemove(true)}
        removeTitle="Remove branch-terminal"
      />
      <ConfirmRemoveDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Remove branch-terminal?"
        description={`Remove branch-terminal "${branchName}"? Its Sprite will be destroyed.`}
        onConfirm={onRemoveBranch}
      />
      {expandable && expanded && <div className="pl-4">{renderNodeChildren?.(node)}</div>}
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

function deriveProjectFieldsFromRepo(repo: { full_name: string; clone_url: string }): { name: string; repoUrl: string } {
  const segments = repo.full_name.split('/');
  return { name: segments[segments.length - 1] || repo.full_name, repoUrl: repo.clone_url };
}

function AddProjectDialog({ onAdd, triggerLabel }: { onAdd(name: string, repoUrl: string): Promise<unknown>; triggerLabel?: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);

  const { repos, connected, isLoading: reposLoading, error: reposError, mutate: refetchRepos } = useGithubRepos(open && !manualMode);
  // Only needed to resolve the github provider for the "Connect GitHub" fallback CTA, so it's gated the same as useGithubRepos rather than fetched on every mount.
  const { providers } = useProviders(open);
  const githubProvider = providers.find((p) => p.slug === 'github') ?? null;

  const mode: 'manual' | 'connect' | 'picker' = manualMode ? 'manual' : connected === false ? 'connect' : 'picker';

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
        onConnected={() => {
          setConnectDialogOpen(false);
          refetchRepos();
        }}
        returnUrl={pathname}
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

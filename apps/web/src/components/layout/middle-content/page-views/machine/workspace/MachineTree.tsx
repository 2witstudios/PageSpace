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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { normalizeProjectName } from '@pagespace/lib/services/machines/project-name';
import { normalizeBranchName } from '@pagespace/lib/services/machines/branch-name';
import ConfirmRemoveDialog from './ConfirmRemoveDialog';
import RemoveButton from './RemoveButton';
import { SidebarLoading } from '../tabs/tab-states';

/** A node in the Machine → Project → Branch tree, passed to `onSelectNode` and `renderNodeChildren`. */
export type MachineTreeNode =
  | { level: 'machine' }
  | { level: 'project'; projectName: string }
  | { level: 'branch'; projectName: string; branchName: string };

interface MachineTreeProps {
  machineId: string;
  /**
   * The machine row's label. Defaults to "Machine" — right on the Machine page,
   * where the page's own title is already in the header and there is only one
   * machine. The Development surface stacks a tree per machine, so it passes
   * each Machine page's title to tell them apart.
   */
  machineLabel?: string;
  /**
   * Whether the machine row starts expanded. Default `true` (the Machine page:
   * one tree, and its projects are the point). The Development surface passes
   * `false` — its machine rows are collapsed until asked for, so listing N
   * machines doesn't fire N project fetches on mount.
   */
  defaultExpanded?: boolean;
  /** Called when a Machine/Project/Branch row is clicked. Omit if the tree itself isn't selectable (e.g. selection lives on injected leaf content instead). */
  onSelectNode?: (node: MachineTreeNode) => void;
  /**
   * Which nodes `onSelectNode` actually applies to. Default: all of them.
   *
   * A row with a select handler uses it INSTEAD of expand-on-label-click (the
   * two are deliberately decoupled — selecting a row must never flip its
   * disclosure state). So a caller that only means one level — the Diff tab
   * selects branches, nothing else — would otherwise turn every Machine/Project
   * label into a dead button. Returning false here leaves that row with the
   * normal expand-on-label-click affordance.
   */
  isNodeSelectable?: (node: MachineTreeNode) => boolean;
  /** The currently-selected node, highlighted and marked `aria-current`. Omit for trees where selection isn't a persistent state (e.g. the Terminal tab, whose clicks open panes rather than select a row). */
  selectedNode?: MachineTreeNode | null;
  /** Renders caller-owned content under a node when it's expanded (e.g. workspace-item rows). Branch nodes are only expandable when this is provided — otherwise they render as a flat, non-expandable row. */
  renderNodeChildren?: (node: MachineTreeNode) => ReactNode;
  /**
   * Renders caller-owned content INLINE in a node's own row, hover-revealed
   * beside the structural add-project/add-branch button (e.g. a "N running"
   * count and a new-workspace `+`). Kept out of `MachineTree` itself — the
   * Diff and Files tabs reuse this same tree for branch/file navigation and
   * have no workspace to count or create, so they simply omit this prop.
   */
  renderNodeExtra?: (node: MachineTreeNode) => ReactNode;
}

/**
 * The node's identity as a string. A `switch` over `level`, so a fourth level can't
 * be added without the compiler pointing here — the pairwise comparison this
 * replaced needed a second `b.level === …` check on every branch purely to
 * re-narrow the type, which read like a real (and confusing) extra condition.
 * NUL-joined for the same reason the Diff tab's React keys are: these names can
 * contain '/' and ':'.
 */
function nodeKey(node: MachineTreeNode): string {
  switch (node.level) {
    case 'machine':
      return 'machine';
    case 'project':
      return `project\u0000${node.projectName}`;
    case 'branch':
      return `branch\u0000${node.projectName}\u0000${node.branchName}`;
  }
}

/** Do two tree nodes address the same thing? */
export function isSameMachineTreeNode(a: MachineTreeNode | null | undefined, b: MachineTreeNode | null | undefined): boolean {
  return a != null && b != null && nodeKey(a) === nodeKey(b);
}

/** Presentation-only Machine → Project → Branch tree, reusable across any tab that needs this navigation shape (Terminal, Diff, …). Has no opinion on what a row click does — callers own that via `onSelectNode`. */
export default function MachineTree({ machineId, machineLabel, defaultExpanded, onSelectNode, isNodeSelectable, selectedNode, renderNodeChildren, renderNodeExtra }: MachineTreeProps) {
  return (
    <div className="p-1 text-sm">
      <MachineNode
        machineId={machineId}
        machineLabel={machineLabel}
        defaultExpanded={defaultExpanded}
        onSelectNode={onSelectNode}
        isNodeSelectable={isNodeSelectable}
        selectedNode={selectedNode}
        renderNodeChildren={renderNodeChildren}
        renderNodeExtra={renderNodeExtra}
      />
    </div>
  );
}

/** The row's select handler, or undefined when this node isn't selectable — in which case its label falls back to expand/collapse. */
function selectHandlerFor(
  node: MachineTreeNode,
  onSelectNode?: (node: MachineTreeNode) => void,
  isNodeSelectable?: (node: MachineTreeNode) => boolean,
): (() => void) | undefined {
  if (!onSelectNode) return undefined;
  if (isNodeSelectable && !isNodeSelectable(node)) return undefined;
  return () => onSelectNode(node);
}

function TreeRow({
  expanded,
  onToggleExpand,
  onSelect,
  selected,
  icon,
  label,
  labelClassName,
  extra,
  onRemove,
  removeTitle,
}: {
  expanded?: boolean;
  onToggleExpand?(): void;
  onSelect?(): void;
  selected?: boolean;
  icon: ReactNode;
  label: string;
  labelClassName?: string;
  /** Hover-revealed row content between the label and the remove button — the
   * structural add-child dialog trigger, plus whatever `renderNodeExtra` hands
   * back. */
  extra?: ReactNode;
  onRemove?(): void;
  removeTitle?: string;
}) {
  // With no onSelect action, clicking the label falls back to expand/collapse
  // (matching the old Navigator's whole-row-click affordance) rather than being
  // a dead, disabled button. When onSelect IS provided it wins, so selection
  // stays decoupled from expansion for callers that use it.
  const onLabelClick = onSelect ?? onToggleExpand;
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-sm py-1 pr-1',
        // Hover must not fight the selected state: bg-accent and hover:bg-accent/50
        // are different variant groups, so twMerge keeps both and the hover rule
        // wins — pointing at the selected row would LIGHTEN it, making it read as
        // less selected than its unhovered siblings.
        selected ? 'bg-accent' : 'hover:bg-accent/50',
      )}
    >
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
        onClick={onLabelClick}
        disabled={!onLabelClick}
        // aria-current belongs on the INTERACTIVE element, not the row wrapper: the
        // wrapper has no role and isn't focusable, so a screen-reader user never
        // reaches it and the selection would be conveyed by background colour alone.
        aria-current={selected ? 'true' : undefined}
        className={cn('flex flex-1 items-center gap-1 text-left', !onLabelClick && 'cursor-default')}
      >
        {icon}
        <span className={cn('truncate', labelClassName)}>{label}</span>
      </button>
      {extra}
      {onRemove && removeTitle && <RemoveButton onClick={onRemove} label={removeTitle} />}
    </div>
  );
}

interface TreeLevelProps {
  onSelectNode?: (node: MachineTreeNode) => void;
  isNodeSelectable?: (node: MachineTreeNode) => boolean;
  selectedNode?: MachineTreeNode | null;
  renderNodeChildren?: (node: MachineTreeNode) => ReactNode;
  renderNodeExtra?: (node: MachineTreeNode) => ReactNode;
}

function MachineNode({
  machineId,
  machineLabel = 'Machine',
  defaultExpanded = true,
  onSelectNode,
  isNodeSelectable,
  selectedNode,
  renderNodeChildren,
  renderNodeExtra,
}: TreeLevelProps & { machineId: string; machineLabel?: string; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const node: MachineTreeNode = { level: 'machine' };
  const { projects, isLoading: projectsLoading, addProject, removeProject } = useMachineProjects(expanded ? machineId : null);

  return (
    <div>
      <TreeRow
        expanded={expanded}
        onToggleExpand={() => setExpanded((e) => !e)}
        onSelect={selectHandlerFor(node, onSelectNode, isNodeSelectable)}
        selected={isSameMachineTreeNode(node, selectedNode)}
        icon={<Cpu className="size-3.5 shrink-0" />}
        label={machineLabel}
        labelClassName="font-medium"
        extra={
          <>
            {renderNodeExtra?.(node)}
            <AddProjectDialog onAdd={addProject} />
          </>
        }
      />
      {expanded && (
        <div className="pl-4">
          {renderNodeChildren?.(node)}
          {projectsLoading && <SidebarLoading message="Loading projects…" />}
          {projects.map((project) => (
            <ProjectNode
              key={project.name}
              machineId={machineId}
              projectName={project.name}
              onSelectNode={onSelectNode}
              isNodeSelectable={isNodeSelectable}
              selectedNode={selectedNode}
              renderNodeChildren={renderNodeChildren}
              renderNodeExtra={renderNodeExtra}
              onRemoveProject={() => removeProject(project.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectNode({
  machineId,
  projectName,
  onSelectNode,
  isNodeSelectable,
  selectedNode,
  renderNodeChildren,
  renderNodeExtra,
  onRemoveProject,
}: TreeLevelProps & {
  machineId: string;
  projectName: string;
  onRemoveProject(): Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const node: MachineTreeNode = { level: 'project', projectName };
  const { branches, isLoading: branchesLoading, addBranch, removeBranch } = useMachineBranches(expanded ? machineId : null, projectName);

  return (
    <div>
      <TreeRow
        expanded={expanded}
        onToggleExpand={() => setExpanded((e) => !e)}
        onSelect={selectHandlerFor(node, onSelectNode, isNodeSelectable)}
        selected={isSameMachineTreeNode(node, selectedNode)}
        icon={<FolderGit2 className="size-3.5 shrink-0" />}
        label={projectName}
        labelClassName="font-medium"
        extra={
          <>
            {renderNodeExtra?.(node)}
            <AddBranchDialog onAdd={addBranch} />
          </>
        }
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
          {branchesLoading && <SidebarLoading message="Loading branches…" />}
          {branches.map((branch) => (
            <BranchNode
              key={branch.branchName}
              projectName={projectName}
              branchName={branch.branchName}
              onSelectNode={onSelectNode}
              isNodeSelectable={isNodeSelectable}
              selectedNode={selectedNode}
              renderNodeChildren={renderNodeChildren}
              renderNodeExtra={renderNodeExtra}
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
  isNodeSelectable,
  selectedNode,
  renderNodeChildren,
  renderNodeExtra,
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
        onSelect={selectHandlerFor(node, onSelectNode, isNodeSelectable)}
        selected={isSameMachineTreeNode(node, selectedNode)}
        icon={<GitBranch className="size-3.5 shrink-0" />}
        label={branchName}
        extra={renderNodeExtra?.(node)}
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

/** Short project name from a GitHub `full_name` (e.g. "org/my-repo" -> "my-repo"), and the ready-to-clone URL. */
export function deriveProjectFieldsFromRepo(repo: { full_name: string; clone_url: string }): { name: string; repoUrl: string } {
  const segments = repo.full_name.split('/');
  return { name: segments[segments.length - 1] || repo.full_name, repoUrl: repo.clone_url };
}

/** Hover-revealed trigger chrome shared by the two "add a child node" dialogs
 * (project, branch) — the non-destructive sibling of `RemoveButton`'s reveal
 * pattern, built on `Button` (rather than the plain `AddButton`) because a
 * `DialogTrigger asChild` needs a ref-forwarding child. */
const ADD_DIALOG_TRIGGER_CLASSNAME =
  'size-5 opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100';

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

function AddProjectDialog({ onAdd }: { onAdd(name: string, repoUrl: string): Promise<unknown> }) {
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
        <Button variant="ghost" size="icon" className={ADD_DIALOG_TRIGGER_CLASSNAME} title="Add project">
          <Plus className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>Clone a git repo onto this machine&apos;s persistent filesystem.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
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
        <Button variant="ghost" size="icon" className={ADD_DIALOG_TRIGGER_CLASSNAME} title="Add branch-terminal">
          <Plus className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add branch-terminal</DialogTitle>
          <DialogDescription>Checks out this branch in its own isolated Sprite.</DialogDescription>
        </DialogHeader>
        <div>
          <Input placeholder="Branch name" value={branchName} onChange={(e) => setBranchName(e.target.value)} />
          <NamePreview value={branchName} normalize={normalizeBranchName} />
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={submitting || !branchName.trim()}>
            {submitting ? 'Spawning…' : 'Add branch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

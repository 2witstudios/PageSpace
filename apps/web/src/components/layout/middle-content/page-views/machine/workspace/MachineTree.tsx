"use client";

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ChevronRight, ChevronDown, Cpu, FolderGit2, GitBranch } from 'lucide-react';
import { useMachineProjects } from '@/hooks/useMachineProjects';
import { useMachineBranches } from '@/hooks/useMachineBranches';
import ConfirmRemoveDialog from './ConfirmRemoveDialog';
import RemoveButton from './RemoveButton';
import NodeActionPalette from './NodeActionPalette';
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
  /**
   * When provided, every node's single "+" action palette offers a "New
   * terminal" action that spawns an agent into a freshly created workspace
   * at that node's scope, reporting the new workspace's id here. Omit for
   * trees with no workspace concept (the Diff and Files tabs render this
   * same tree BARE) — their palette then offers only Add project/Add branch.
   */
  onWorkspaceCreated?: (workspaceId: string) => void;
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

/**
 * Machine → Project → Branch tree, reusable across any tab that needs this
 * navigation shape (Terminal, Diff, …). Has no opinion on what a row CLICK
 * does — callers own that via `onSelectNode` — and no opinion on workspaces:
 * the "N running" badge and the workspace-item leaves under an expanded node
 * are entirely caller-owned too, via `renderNodeExtra`/`renderNodeChildren`.
 *
 * It does own one thing directly: every row's single "+" action palette
 * (`NodeActionPalette`), because "Add project"/"Add branch" are structural to
 * THIS tree (backed by `useMachineProjects`/`useMachineBranches`, called
 * here) — that part predates this file's workspace-agnosticism and was never
 * caller-injected. "New terminal" rides along in the same palette rather than
 * getting a second `+`, so it's real when `onWorkspaceCreated` is passed and
 * simply absent (the palette then offers only Add project/Add branch) for
 * the Diff/Files tabs that render this tree bare.
 */
export default function MachineTree({ machineId, machineLabel, defaultExpanded, onSelectNode, isNodeSelectable, selectedNode, renderNodeChildren, renderNodeExtra, onWorkspaceCreated }: MachineTreeProps) {
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
        onWorkspaceCreated={onWorkspaceCreated}
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
        'group flex items-center gap-1 rounded-sm py-0.5 pr-1 leading-none',
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
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
      ) : (
        <span className="size-3 shrink-0" aria-hidden="true" />
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
        <span className="truncate font-normal text-sm leading-none">{label}</span>
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
  onWorkspaceCreated?: (workspaceId: string) => void;
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
  onWorkspaceCreated,
}: TreeLevelProps & { machineId: string; machineLabel?: string; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const node: MachineTreeNode = { level: 'machine' };
  // The row's "+" action palette is always mounted (hover-revealed on the
  // row itself, not gated by expansion — see MachineTree's header-ectomy), so
  // `addProject` must work before the row is ever expanded. Only the list
  // FETCH is gated on `expanded`.
  const { projects, isLoading: projectsLoading, addProject, removeProject } = useMachineProjects(machineId, { enabled: expanded });

  return (
    <div>
      <TreeRow
        expanded={expanded}
        onToggleExpand={() => setExpanded((e) => !e)}
        onSelect={selectHandlerFor(node, onSelectNode, isNodeSelectable)}
        selected={isSameMachineTreeNode(node, selectedNode)}
        icon={<Cpu className="size-3 shrink-0" />}
        label={machineLabel}
        extra={
          <>
            {renderNodeExtra?.(node)}
            <NodeActionPalette machineId={machineId} node={node} onAddProject={addProject} onWorkspaceCreated={onWorkspaceCreated} />
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
              onWorkspaceCreated={onWorkspaceCreated}
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
  onWorkspaceCreated,
  onRemoveProject,
}: TreeLevelProps & {
  machineId: string;
  projectName: string;
  onRemoveProject(): Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const node: MachineTreeNode = { level: 'project', projectName };
  // Same reasoning as the machine row's "+" action palette above: "Add
  // branch" is always mounted, so `addBranch` must work before the row is
  // ever expanded. Only the list FETCH is gated on `expanded`.
  const { branches, isLoading: branchesLoading, addBranch, removeBranch } = useMachineBranches(machineId, projectName, { enabled: expanded });

  return (
    <div>
      <TreeRow
        expanded={expanded}
        onToggleExpand={() => setExpanded((e) => !e)}
        onSelect={selectHandlerFor(node, onSelectNode, isNodeSelectable)}
        selected={isSameMachineTreeNode(node, selectedNode)}
        icon={<FolderGit2 className="size-3 shrink-0" />}
        label={projectName}
        extra={
          <>
            {renderNodeExtra?.(node)}
            <NodeActionPalette machineId={machineId} node={node} onAddBranch={addBranch} onWorkspaceCreated={onWorkspaceCreated} />
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
              machineId={machineId}
              projectName={projectName}
              branchName={branch.branchName}
              onSelectNode={onSelectNode}
              isNodeSelectable={isNodeSelectable}
              selectedNode={selectedNode}
              renderNodeChildren={renderNodeChildren}
              renderNodeExtra={renderNodeExtra}
              onWorkspaceCreated={onWorkspaceCreated}
              onRemoveBranch={() => removeBranch(branch.branchName)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BranchNode({
  machineId,
  projectName,
  branchName,
  onSelectNode,
  isNodeSelectable,
  selectedNode,
  renderNodeChildren,
  renderNodeExtra,
  onWorkspaceCreated,
  onRemoveBranch,
}: TreeLevelProps & {
  machineId: string;
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
        icon={<GitBranch className="size-3 shrink-0" />}
        label={branchName}
        extra={
          <>
            {renderNodeExtra?.(node)}
            <NodeActionPalette machineId={machineId} node={node} onWorkspaceCreated={onWorkspaceCreated} />
          </>
        }
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

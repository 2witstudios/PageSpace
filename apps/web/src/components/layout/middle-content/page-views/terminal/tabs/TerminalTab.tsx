"use client";

import { useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { Plus, TerminalSquare, X } from 'lucide-react';
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
import { useAgentTerminals, type AgentTerminal } from '@/hooks/useAgentTerminals';
import { AGENT_LAUNCH_SPECS, type AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import { useTerminalWorkspaceStore, type OpenTerminalScope } from '@/stores/terminal-workspace/useTerminalWorkspaceStore';
import MachineTree, { type MachineTreeNode } from '../workspace/MachineTree';

const AGENT_TYPES = Object.keys(AGENT_LAUNCH_SPECS) as AgentRuntimeType[];

// TerminalWorkspace owns the xterm subtree + socket; it must never SSR.
const TerminalWorkspace = dynamic(() => import('../workspace/TerminalWorkspace'), { ssr: false });

interface TerminalTabProps {
  /** The Machine page's own id (= pageId). Sessions/panes are keyed by it. */
  machineId: string;
}

/**
 * The Machine page's Terminal tab: a page-scoped inner sidebar (plain
 * border chrome — deliberately NOT the app's liquid-glass sidebars) rendering
 * the shared {@link MachineTree} with session-terminal leaves injected under
 * every Machine/Project/Branch node, beside the pane workspace. This is the new
 * home of the session navigation that used to live in the right-sidebar
 * Navigator tab — clicking a session opens it in the workspace via the shared
 * terminal-workspace store, exactly as before.
 */
export default function TerminalTab({ machineId }: TerminalTabProps) {
  const openTerminal = useTerminalWorkspaceStore((state) => state.openTerminal);
  const onOpenTerminal = useCallback(
    (scope: OpenTerminalScope) => openTerminal(machineId, scope),
    [openTerminal, machineId],
  );

  const renderNodeChildren = useCallback(
    (node: MachineTreeNode) => (
      <SessionLeaves machineId={machineId} node={node} onOpenTerminal={onOpenTerminal} />
    ),
    [machineId, onOpenTerminal],
  );

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sessions</span>
        </div>
        <ScrollArea className="flex-1">
          <MachineTree machineId={machineId} renderNodeChildren={renderNodeChildren} />
        </ScrollArea>
      </aside>
      <div className="min-w-0 flex-1">
        <TerminalWorkspace machineId={machineId} />
      </div>
    </div>
  );
}

/** Resolves a tree node to the `useAgentTerminals` scope it addresses, and the
 * `OpenTerminalScope` a session under it opens with. */
function useNodeTerminals(machineId: string, node: MachineTreeNode) {
  const projectName = node.level === 'machine' ? null : node.projectName;
  const branchName = node.level === 'branch' ? node.branchName : null;
  const scopeFor = useCallback(
    (name: string): OpenTerminalScope => ({
      projectName: projectName ?? undefined,
      branchName: branchName ?? undefined,
      name,
    }),
    [projectName, branchName],
  );
  return { terminals: useAgentTerminals(machineId, projectName, branchName), scopeFor };
}

/** Session-terminal leaves injected by {@link MachineTree}'s `renderNodeChildren`
 * under each expanded node — mounts (and thus fetches) only while its node is
 * open. */
function SessionLeaves({
  machineId,
  node,
  onOpenTerminal,
}: {
  machineId: string;
  node: MachineTreeNode;
  onOpenTerminal(scope: OpenTerminalScope): void;
}) {
  const { terminals, scopeFor } = useNodeTerminals(machineId, node);
  const { agentTerminals, isLoading, addAgentTerminal, removeAgentTerminal } = terminals;

  return (
    <TerminalList
      terminals={agentTerminals}
      isLoading={isLoading}
      onAdd={addAgentTerminal}
      onRemove={removeAgentTerminal}
      onOpen={(name) => onOpenTerminal(scopeFor(name))}
    />
  );
}

function TerminalList({
  terminals,
  isLoading,
  onAdd,
  onRemove,
  onOpen,
}: {
  terminals: AgentTerminal[];
  isLoading: boolean;
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
      {!isLoading && terminals.length === 0 && (
        <div className="px-2 py-1 text-xs text-muted-foreground">No terminals yet</div>
      )}
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

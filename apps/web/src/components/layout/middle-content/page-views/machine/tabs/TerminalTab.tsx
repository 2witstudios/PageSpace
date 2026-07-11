"use client";

import { useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { Plus, TerminalSquare } from 'lucide-react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAgentTerminals, type AgentTerminal } from '@/hooks/useAgentTerminals';
import { AGENT_LAUNCH_SPECS, type AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import { useMachineWorkspaceStore, type OpenTerminalScope } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import MachineTree, { type MachineTreeNode } from '../workspace/MachineTree';
import ConfirmRemoveDialog from '../workspace/ConfirmRemoveDialog';
import RemoveButton from '../workspace/RemoveButton';
import TabSidebar from './TabSidebar';
import { SidebarLoading, SidebarNotice } from './tab-states';

const AGENT_TYPES = Object.keys(AGENT_LAUNCH_SPECS) as AgentRuntimeType[];

// MachineWorkspace owns the xterm subtree + socket; it must never SSR.
const MachineWorkspace = dynamic(() => import('../workspace/MachineWorkspace'), { ssr: false });

interface TerminalTabProps {
  /** The Machine page's own id (= pageId). Sessions/panes are keyed by it. */
  machineId: string;
}

/**
 * The Machine page's Terminal tab: the shared {@link TabSidebar} (plain border
 * chrome — deliberately NOT the app's liquid-glass sidebars) rendering the shared
 * {@link MachineTree} with session-terminal leaves injected under every
 * Machine/Project/Branch node, beside the pane workspace. This is the new home of
 * the session navigation that used to live in the right-sidebar Navigator tab —
 * clicking a session opens it in the workspace via the shared terminal-workspace
 * store, exactly as before.
 *
 * Opening a session also `close()`s the sidebar, which on a narrow viewport
 * dismisses the sheet the tree is in — the user asked to look at that terminal,
 * and it is behind the sheet.
 */
export default function TerminalTab({ machineId }: TerminalTabProps) {
  return (
    <TabSidebar title="Sessions" pane={<MachineWorkspace machineId={machineId} />}>
      {({ close }) => <SessionTree machineId={machineId} onOpened={close} />}
    </TabSidebar>
  );
}

/**
 * The session tree. A component rather than inline JSX so the open handler — and
 * through it `renderNodeChildren` — can be built with `useCallback` in a scope
 * that has stable inputs: `TabSidebar` hands out a stable `close`, so this memo
 * genuinely holds instead of being invalidated by a fresh closure every render.
 */
function SessionTree({ machineId, onOpened }: { machineId: string; onOpened: () => void }) {
  const openTerminal = useMachineWorkspaceStore((state) => state.openTerminal);

  const onOpenTerminal = useCallback(
    (scope: OpenTerminalScope) => {
      openTerminal(machineId, scope);
      // On a narrow viewport the tree is in a sheet, and the terminal the user
      // just asked for is behind it. A no-op on desktop.
      onOpened();
    },
    [openTerminal, machineId, onOpened],
  );

  const renderNodeChildren = useCallback(
    (node: MachineTreeNode) => (
      <SessionLeaves machineId={machineId} node={node} onOpenTerminal={onOpenTerminal} />
    ),
    [machineId, onOpenTerminal],
  );

  return <MachineTree machineId={machineId} renderNodeChildren={renderNodeChildren} />;
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
      {isLoading && <SidebarLoading message="Loading terminals…" />}
      {!isLoading && terminals.length === 0 && (
        <SidebarNotice
          title="No terminals yet"
          description="Add one to start an agent session at this node's scope."
        />
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
          <RemoveButton onClick={() => setPendingRemove(terminal.name)} label={`Remove terminal ${terminal.name}`} />
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


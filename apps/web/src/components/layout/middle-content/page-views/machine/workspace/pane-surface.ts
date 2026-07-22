/**
 * Which surface a bound pane renders (#2166, Phase 10) — a pure decision,
 * colocated-tested like `tab-states`, so the render branch in TerminalPanes
 * stays a lookup rather than a policy.
 *
 * Precedence: an explicit `kind` on the pane's scope (Phase 9) wins outright —
 * it was written at bind time by the path that KNEW what it was spawning. Only
 * a kind-less binding (pre-#2166, or a path that didn't set it) falls back to
 * resolving the session's agentType from the workspace's SWR session list, and
 * there the unanswered list means `loading`, never a mounted Xterm: opening a
 * PTY stream registers this pane as a viewer server-side, so guessing "pty"
 * for what turns out to be a chat isn't a harmless flash, it's a connection.
 *
 * The list consulted is the WORKSPACE's (the one TerminalPanes already
 * subscribes to for spawning), and it is unconditionally THIS pane's list: a
 * pane stores only `{name, kind}` and runs at its workspace's checkout, so
 * there is no foreign-scope case to opt out of. The old escape hatch —
 * "unresolvable against this list, therefore a terminal" — resolved a
 * kind-less chat pane to an Xterm the moment a layout carried one.
 */
import {
  agentSurfaceOf,
  isAgentRuntimeType,
  type AgentRuntimeType,
} from '@pagespace/lib/services/machines/agent-terminal-types';
import type { PaneSessionScope } from '@/stores/machine-workspace/workspace-reducer';

/** The slice of an `AgentTerminal` row this decision reads. */
export interface PaneSessionRow {
  /** The row's own id — for chat surfaces, the conversation id (Phase 4). */
  id: string;
  name: string;
  /** Raw DB value; can name a retired AGENT_LAUNCH_SPECS entry. */
  agentType: string;
}

export type PaneSurface =
  /** The list hasn't answered and the binding carries no kind — hold. */
  | { surface: 'loading' }
  | { surface: 'terminal' }
  /** `terminalId` is the session ROW id MachinePaneChat is addressed by —
   * `null` until the list turns it up (the caller shows loading meanwhile). */
  | { surface: 'chat'; terminalId: string | null };

export function resolvePaneSurface(params: {
  /** What the pane stores — its name within its workspace's checkout, and
   * (when it was tagged at bind time) its surface. */
  scope: PaneSessionScope;
  agentTerminals: readonly PaneSessionRow[];
  isLoading: boolean;
}): PaneSurface {
  const { scope, agentTerminals, isLoading } = params;

  if (scope.kind === 'terminal') return { surface: 'terminal' };

  const row = agentTerminals.find((terminal) => terminal.name === scope.name);

  if (scope.kind === 'chat') return { surface: 'chat', terminalId: row?.id ?? null };

  if (row) {
    return isAgentRuntimeType(row.agentType) && agentSurfaceOf(row.agentType) === 'chat'
      ? { surface: 'chat', terminalId: row.id }
      : { surface: 'terminal' };
  }
  if (isLoading) return { surface: 'loading' };
  // Loaded and absent: a kind-less binding predates chat panes, so the legacy
  // reading — a PTY — is the safe one.
  return { surface: 'terminal' };
}

/** What each agent type presents as everywhere a picker lists it. TOTAL by
 * design — a new registry entry fails compilation here until it declares its
 * label, instead of silently leaking its raw key into the UI. `pagespace` is
 * just "Agent": agents and chats are one thing, and PageSpace is the assumed
 * context — we are pushing people toward it, not branding it as an add-on. */
const AGENT_TYPE_LABELS: Record<AgentRuntimeType, string> = {
  pagespace: 'Agent',
  shell: 'Shell',
};

/** Display label for an agent type — "Agent" for the chat agent, "Shell" for the PTY. */
export function agentTypeLabelOf(type: AgentRuntimeType): string {
  return AGENT_TYPE_LABELS[type];
}

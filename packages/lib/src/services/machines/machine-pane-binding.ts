/**
 * Machine Pane binding: pure core (IO injected, no DB, no clock).
 *
 * The "PageSpace Agent" pane type (issue #2166) reuses `POST /api/ai/chat` in
 * DEFAULT mode with `conversationId := machine_agent_terminals.id` — a
 * `pagespace`-typed agent-terminal row IS the pane's identity. This module
 * derives that row into the server-authoritative binding that pins the run's
 * default-mode code-exec tools (bash/readFile/writeFile/editFile) to the
 * right machine checkout, mirroring `resolveLocationForRow` in
 * `agent-terminals.ts` (same branch → project → machine dispatch, by the
 * row's own nullable scope columns) but for the pane's tool-context seam
 * instead of the realtime PTY bridge.
 *
 * `chatId` (the Machine page id the client claims to be talking to) is
 * checked against the resolved row's OWN `machineId` — never trusted from the
 * row alone — because `conversationId` is client-suppliable and a stale or
 * forged pairing must not silently bind tools to a DIFFERENT machine than the
 * pane the user is actually looking at.
 */

import type { MachineAgentTerminalStore } from './agent-terminals-store';

/** The agent-terminal `agentType` that marks a row as a PageSpace Agent pane (not a PTY session). */
const PAGESPACE_AGENT_TYPE = 'pagespace';

export type MachinePaneBindingFailureReason = 'binding_page_mismatch' | 'project_not_found' | 'branch_not_found';

export interface MachinePaneBindingBranchSandbox {
  machineBranchId: string;
  sandboxId: string;
}

export interface MachinePaneBinding {
  cwd: string;
  branchSandbox?: MachinePaneBindingBranchSandbox;
}

export type MachinePaneBindingResult =
  | null
  | { ok: true; binding: MachinePaneBinding }
  | { ok: false; reason: MachinePaneBindingFailureReason };

export interface DeriveMachinePaneBindingInput {
  /** The Machine page id the client claims this pane belongs to. */
  chatId: string;
  /** The agent-terminal row id (`machine_agent_terminals.id`) backing this pane. */
  conversationId: string;
}

/** The minimal slice of the Projects store this module needs — just enough to resolve a project's clone path. */
export interface MachinePaneBindingProjectLookup {
  findByName(machineId: string, name: string): Promise<{ path: string } | null>;
}

/** The minimal slice of the Branches store this module needs — a branch's Sprite plus whether it's been confirmed destroyed. */
export interface MachinePaneBindingBranchLookup {
  findById(machineBranchId: string): Promise<{ sandboxId: string; spriteTornDownAt: Date | null } | null>;
}

export interface DeriveMachinePaneBindingDeps {
  terminalStore: Pick<MachineAgentTerminalStore, 'findById'>;
  projectLookup: MachinePaneBindingProjectLookup;
  branchLookup: MachinePaneBindingBranchLookup;
}

/**
 * Derive the machine-pane tool binding for a conversation, or `null` when
 * this conversation isn't a machine-bound PageSpace Agent pane at all (no
 * row, or a page agent's own `agentType` — its conversation is never
 * machine-bound). A resolved `pagespace` row that fails page-identity or
 * scope-existence checks fails CLOSED (`ok: false`) rather than falling back
 * to an unbound run.
 */
// RED: intentionally unimplemented — see __tests__/machine-pane-binding.test.ts.
export async function deriveMachinePaneBinding(
  _input: DeriveMachinePaneBindingInput,
  _deps: DeriveMachinePaneBindingDeps,
): Promise<MachinePaneBindingResult> {
  throw new Error('deriveMachinePaneBinding: not implemented');
}

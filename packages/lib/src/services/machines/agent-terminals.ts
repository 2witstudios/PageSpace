/**
 * Agent Terminals: spawn / resolve (attach) / kill / list named, pluggable-
 * agent-typed PTY sessions inside a branch-terminal's Sprite (IO,
 * dependency-injected where it touches the DB/sandbox).
 *
 * "An agent spawns multiple terminals = multiple sessions, pluggable agent
 * type" (tasks/terminal.md, Terminal Epic 2 Runtime tier). UNLIKE Branches —
 * where each branch gets its OWN Sprite — an agent terminal does NOT
 * provision a new Sprite: it is a named PTY session running INSIDE the
 * branch's already-provisioned Sprite (`machine_branches`), addressed by
 * (machineBranchId, name). A branch's Sprite can host many concurrent agent
 * terminals side by side (e.g. a `pagespace-cli` one and a `claude` one).
 *
 * `spawnAgentTerminal` only reserves the (name, agentType) tracking row — it
 * does NOT eagerly open the Sprite exec session. The actual PTY is created
 * lazily by the realtime bridge on first connect (mirrors how a Terminal
 * page's shell is never opened until a socket connects — see
 * `apps/realtime/src/terminal/terminal-handler.ts`), which then persists the
 * discovered/created Sprite session id back via `updateStreamSessionId` so a
 * later reconnect can reattach instead of spawning a duplicate process.
 * `killAgentTerminal` is the one place THIS module drives the Sprite directly
 * (through the `MachineHost` seam), since killing a still-open session must
 * happen even if no realtime connection is currently attached to it.
 */

import type { MachineHost } from '../sandbox/machine-host';
import { isUniqueViolation, type MachineAgentTerminalStore, type MachineAgentTerminalRecord } from './agent-terminals-store';
import { isValidAgentTerminalName, isAgentRuntimeType, type AgentRuntimeType } from './agent-terminal-types';

/** The minimal slice of the Branches store this module needs — just enough to resolve a branch's Sprite (`sandboxId`) by name. */
export interface AgentTerminalBranchLookup {
  findByName(terminalId: string, projectName: string, branchName: string): Promise<{ id: string; sandboxId: string } | null>;
}

export interface AgentTerminalsDeps {
  branchStore: AgentTerminalBranchLookup;
  store: MachineAgentTerminalStore;
  host: MachineHost;
  now: () => Date;
}

/** Each function below asks for exactly the slice of `AgentTerminalsDeps` it touches — e.g. a read-only resolver never needs `host`, so a caller (like the realtime PTY bridge) doesn't have to fabricate one just to satisfy the type. */
export type SpawnAgentTerminalDeps = Pick<AgentTerminalsDeps, 'branchStore' | 'store' | 'now'>;
export type ResolveAgentTerminalDeps = Pick<AgentTerminalsDeps, 'branchStore' | 'store'>;
export type ListAgentTerminalsDeps = Pick<AgentTerminalsDeps, 'branchStore' | 'store'>;
export type KillAgentTerminalDeps = Pick<AgentTerminalsDeps, 'branchStore' | 'store' | 'host'>;

export interface AgentTerminalActor {
  userId: string;
}

export interface AgentTerminalTarget {
  terminalId: string;
  projectName: string;
  branchName: string;
  name: string;
}

export type SpawnAgentTerminalDenialReason = 'invalid_name' | 'invalid_agent_type' | 'branch_not_found' | 'name_in_use' | 'error';

/** Pure decision: is this (name, agentType) safe to reserve as an agent terminal? */
export function planSpawnAgentTerminal(input: { name: string; agentType: string }):
  | { ok: true }
  | { ok: false; reason: 'invalid_name' | 'invalid_agent_type' } {
  if (!isValidAgentTerminalName(input.name)) return { ok: false, reason: 'invalid_name' };
  if (!isAgentRuntimeType(input.agentType)) return { ok: false, reason: 'invalid_agent_type' };
  return { ok: true };
}

export type SpawnAgentTerminalResult =
  | { ok: true; id: string; agentType: AgentRuntimeType; resumed: boolean }
  | { ok: false; reason: SpawnAgentTerminalDenialReason };

/**
 * Spawn (or resume) a named agent terminal in a branch's Sprite. Idempotent
 * by (machineBranchId, name) with the SAME agentType — a second call for an
 * already-reserved name returns the existing reservation instead of erroring;
 * reusing the name under a DIFFERENT agentType is rejected (`name_in_use`)
 * rather than silently repurposing an existing session's identity.
 */
export async function spawnAgentTerminal({
  terminalId,
  projectName,
  branchName,
  name,
  agentType,
  actor,
  deps,
}: AgentTerminalTarget & { agentType: string; actor: AgentTerminalActor; deps: SpawnAgentTerminalDeps }): Promise<SpawnAgentTerminalResult> {
  const plan = planSpawnAgentTerminal({ name, agentType });
  if (!plan.ok) return plan;
  const resolvedType = agentType as AgentRuntimeType;

  const branch = await deps.branchStore.findByName(terminalId, projectName, branchName);
  if (!branch) return { ok: false, reason: 'branch_not_found' };

  const existing = await deps.store.findByName(branch.id, name);
  if (existing) {
    if (existing.agentType !== resolvedType) return { ok: false, reason: 'name_in_use' };
    return { ok: true, id: existing.id, agentType: resolvedType, resumed: true };
  }

  try {
    const row = await deps.store.create({
      ownerId: actor.userId,
      machineBranchId: branch.id,
      name,
      agentType: resolvedType,
      now: deps.now(),
    });
    return { ok: true, id: row.id, agentType: resolvedType, resumed: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Lost a race against a concurrent spawn of the same name.
      const reconciled = await deps.store.findByName(branch.id, name);
      if (reconciled && reconciled.agentType === resolvedType) {
        return { ok: true, id: reconciled.id, agentType: resolvedType, resumed: true };
      }
      if (reconciled) return { ok: false, reason: 'name_in_use' };
    }
    return { ok: false, reason: 'error' };
  }
}

export type ResolveAgentTerminalResult =
  | { ok: true; agentTerminalId: string; sandboxId: string; agentType: AgentRuntimeType; streamSessionId: string | null }
  | { ok: false; reason: 'branch_not_found' | 'not_found' };

/**
 * Resolve a named agent terminal down to what the realtime PTY bridge needs
 * to open (or reattach) its stream: which Sprite (`sandboxId`), which launch
 * spec (`agentType`), and any already-known Sprite session id to reattach to.
 * Read-only — never provisions or drives the Sprite.
 */
export async function resolveAgentTerminal({
  terminalId,
  projectName,
  branchName,
  name,
  deps,
}: AgentTerminalTarget & { deps: ResolveAgentTerminalDeps }): Promise<ResolveAgentTerminalResult> {
  const branch = await deps.branchStore.findByName(terminalId, projectName, branchName);
  if (!branch) return { ok: false, reason: 'branch_not_found' };

  const row = await deps.store.findByName(branch.id, name);
  if (!row || !isAgentRuntimeType(row.agentType)) return { ok: false, reason: 'not_found' };

  return {
    ok: true,
    agentTerminalId: row.id,
    sandboxId: branch.sandboxId,
    agentType: row.agentType,
    streamSessionId: row.streamSessionId,
  };
}

export async function listAgentTerminals({
  terminalId,
  projectName,
  branchName,
  deps,
}: {
  terminalId: string;
  projectName: string;
  branchName: string;
  deps: ListAgentTerminalsDeps;
}): Promise<{ ok: true; terminals: MachineAgentTerminalRecord[] } | { ok: false; reason: 'branch_not_found' }> {
  const branch = await deps.branchStore.findByName(terminalId, projectName, branchName);
  if (!branch) return { ok: false, reason: 'branch_not_found' };
  const terminals = await deps.store.list(branch.id);
  return { ok: true, terminals };
}

export type KillAgentTerminalResult = { ok: true } | { ok: false; reason: 'branch_not_found' | 'not_found' | 'error' };

/**
 * Tear down a named agent terminal: if its process was ever actually
 * launched (`streamSessionId` set), attach the branch's Sprite through the
 * `MachineHost` seam and kill that specific PTY session, then drop the
 * tracking row. A vanished Sprite (the whole branch is gone) has nothing left
 * to kill, so the row is still dropped rather than orphaned; a live Sprite
 * that fails to kill its session keeps the row so a retry can find it again.
 */
export async function killAgentTerminal({
  terminalId,
  projectName,
  branchName,
  name,
  deps,
}: AgentTerminalTarget & { deps: KillAgentTerminalDeps }): Promise<KillAgentTerminalResult> {
  const branch = await deps.branchStore.findByName(terminalId, projectName, branchName);
  if (!branch) return { ok: false, reason: 'branch_not_found' };

  const row = await deps.store.findByName(branch.id, name);
  if (!row) return { ok: false, reason: 'not_found' };

  if (row.streamSessionId) {
    try {
      const handle = await deps.host.attach({ machineId: branch.sandboxId });
      if (handle) {
        const stream = await handle.stream({ sessionId: row.streamSessionId });
        stream.kill('SIGKILL');
      }
    } catch {
      return { ok: false, reason: 'error' };
    }
  }

  await deps.store.remove(branch.id, name);
  return { ok: true };
}

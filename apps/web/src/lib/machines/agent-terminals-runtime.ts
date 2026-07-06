/**
 * Production wiring for Agent Terminals (Terminal — Workspace, Runtime tier).
 *
 * Binds the provider-agnostic orchestration (`@pagespace/lib/services/machines/
 * agent-terminals`) to the real DB stores. Access is governed by the OWNING
 * Machine's Terminal page — reuses `canAccessMachine`/`canViewMachine` from
 * the Branches runtime (`./machine-branches-runtime`) rather than duplicating
 * that permission check, since an agent terminal is scoped under the same
 * page. Killing an agent terminal is the one operation that drives the
 * branch's Sprite directly, so only it needs a `MachineHost`
 * (`getMachineHostForBranches`); spawning/listing/resolving never provision
 * or touch the Sprite.
 *
 * `projectStore`/`machineSandbox` (project/machine-scope support) are left
 * unwired here — today's only consumer (the navigator API route) is
 * branch-scoped only, and wiring the Machine's own Sprite acquisition would
 * require threading the acting user's resume-re-authz through this module's
 * callers (a route-surface change — separate PR node, see tasks/terminal.md).
 * `branchStore.findById` IS wired, since the level-agnostic resolve/kill path
 * needs no such threading (a branch lookup by its own row id carries no actor
 * context either way).
 */

import { createDbMachineBranchStore } from '@pagespace/lib/services/machines/machine-branches-store';
import { createDbMachineAgentTerminalStore } from '@pagespace/lib/services/machines/agent-terminals-store';
import type {
  SpawnAgentTerminalDeps,
  ResolveAgentTerminalDeps,
  ListAgentTerminalsDeps,
  KillAgentTerminalDeps,
} from '@pagespace/lib/services/machines/agent-terminals';
import { canAccessMachine, canViewMachine, getMachineHostForBranches } from './machine-branches-runtime';

export { canAccessMachine, canViewMachine };

let branchStorePromise: ReturnType<typeof createDbMachineBranchStore> | null = null;
function getMachineBranchStore() {
  branchStorePromise ??= createDbMachineBranchStore();
  return branchStorePromise;
}

let agentTerminalStorePromise: ReturnType<typeof createDbMachineAgentTerminalStore> | null = null;
function getMachineAgentTerminalStore() {
  agentTerminalStorePromise ??= createDbMachineAgentTerminalStore();
  return agentTerminalStorePromise;
}

/** The shared (branchStore, store) slice every agent-terminal deps variant is built from. */
function buildBaseDeps(): Pick<SpawnAgentTerminalDeps & KillAgentTerminalDeps, 'branchStore' | 'store'> {
  return {
    branchStore: {
      findByName: async (terminalId, projectName, branchName) =>
        (await getMachineBranchStore()).findByName(terminalId, projectName, branchName),
      findById: async (id) => (await getMachineBranchStore()).findById(id),
    },
    store: {
      list: async (scope) => (await getMachineAgentTerminalStore()).list(scope),
      findByName: async (scope, name) => (await getMachineAgentTerminalStore()).findByName(scope, name),
      findById: async (id) => (await getMachineAgentTerminalStore()).findById(id),
      create: async (input) => (await getMachineAgentTerminalStore()).create(input),
      updateStreamSessionId: async (input) => (await getMachineAgentTerminalStore()).updateStreamSessionId(input),
      remove: async (scope, name) => (await getMachineAgentTerminalStore()).remove(scope, name),
    },
  };
}

export function buildSpawnAgentTerminalDeps(): SpawnAgentTerminalDeps {
  return { ...buildBaseDeps(), now: () => new Date() };
}

export function buildResolveAgentTerminalDeps(): ResolveAgentTerminalDeps {
  return buildBaseDeps();
}

export function buildListAgentTerminalsDeps(): ListAgentTerminalsDeps {
  return buildBaseDeps();
}

export async function buildKillAgentTerminalDeps(): Promise<KillAgentTerminalDeps> {
  return { ...buildBaseDeps(), host: await getMachineHostForBranches() };
}

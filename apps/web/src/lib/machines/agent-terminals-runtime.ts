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
    },
    store: {
      list: async (machineBranchId) => (await getMachineAgentTerminalStore()).list(machineBranchId),
      findByName: async (machineBranchId, name) => (await getMachineAgentTerminalStore()).findByName(machineBranchId, name),
      create: async (input) => (await getMachineAgentTerminalStore()).create(input),
      updateStreamSessionId: async (input) => (await getMachineAgentTerminalStore()).updateStreamSessionId(input),
      remove: async (machineBranchId, name) => (await getMachineAgentTerminalStore()).remove(machineBranchId, name),
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

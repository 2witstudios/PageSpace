/**
 * Production wiring for the Machine Pane binding pure core
 * (`@pagespace/lib/services/machines/machine-pane-binding`).
 *
 * Memoizes the DB stores — same idiom as `agent-terminals-runtime.ts` /
 * `machine-branches-runtime.ts` (`apps/web/src/lib/machines/`) — and holds NO
 * decision logic: narrowing each store down to the minimal-slice interfaces
 * `deriveMachinePaneBinding` expects is plumbing, not policy.
 */

import { createDbMachineAgentTerminalStore } from '@pagespace/lib/services/machines/agent-terminals-store';
import { createDbMachineProjectStore } from '@pagespace/lib/services/machines/machine-projects-store';
import { createDbMachineBranchStore } from '@pagespace/lib/services/machines/machine-branches-store';
import type { DeriveMachinePaneBindingDeps } from '@pagespace/lib/services/machines/machine-pane-binding';

let terminalStorePromise: ReturnType<typeof createDbMachineAgentTerminalStore> | null = null;
function getMachineAgentTerminalStore() {
  terminalStorePromise ??= createDbMachineAgentTerminalStore();
  return terminalStorePromise;
}

let projectStorePromise: ReturnType<typeof createDbMachineProjectStore> | null = null;
function getMachineProjectStore() {
  projectStorePromise ??= createDbMachineProjectStore();
  return projectStorePromise;
}

let branchStorePromise: ReturnType<typeof createDbMachineBranchStore> | null = null;
function getMachineBranchStore() {
  branchStorePromise ??= createDbMachineBranchStore();
  return branchStorePromise;
}

/** Wires `deriveMachinePaneBinding`'s deps to the real DB-backed stores. */
export function buildMachinePaneBindingDeps(): DeriveMachinePaneBindingDeps {
  return {
    terminalStore: {
      findById: async (id) => (await getMachineAgentTerminalStore()).findById(id),
    },
    projectLookup: {
      findByName: async (machineId, name) => (await getMachineProjectStore()).findByName(machineId, name),
      list: async (machineId) => (await getMachineProjectStore()).list(machineId),
    },
    branchLookup: {
      findById: async (machineBranchId) => (await getMachineBranchStore()).findById(machineBranchId),
      list: async (machineId, projectName) => (await getMachineBranchStore()).list(machineId, projectName),
      listAll: async (machineId) => (await getMachineBranchStore()).listForMachine(machineId),
    },
  };
}

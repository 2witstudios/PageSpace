/**
 * Terminal epics: a MachineRef is either the agent's own machine, or a
 * reference to an existing Terminal page the agent has been granted access
 * to. This mirrors the canonical shared type owned by the sibling "Config
 * model" PR (agent config carries `terminalAccess: boolean` +
 * `machines: MachineRef[]`, machines[0] = default active) — replace this
 * with an import from that module once it merges. Do not diverge from this
 * shape in the meantime.
 */
export type MachineRef = { kind: 'own' } | { kind: 'existing'; terminalId: string };

/** Stable id for a MachineRef, used as the agent-facing handle in list_machines/switch_machine. */
export function machineRefId(machine: MachineRef): string {
  return machine.kind === 'own' ? 'own' : machine.terminalId;
}

export function machineRefEquals(a: MachineRef, b: MachineRef): boolean {
  return machineRefId(a) === machineRefId(b);
}

/** Resolves an agent-facing id (from switch_machine's input) back to a configured MachineRef. */
export function machineRefFromId(id: string, configured: MachineRef[]): MachineRef | undefined {
  return configured.find((m) => machineRefId(m) === id);
}

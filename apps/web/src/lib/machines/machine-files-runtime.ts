/**
 * Production wiring for the Machine Files browse API (Machine page rebuild,
 * Phase 1 — working-tree file browsing).
 *
 * Resolves a branch-terminal's LIVE `MachineHandle` (its own Sprite) so the
 * route can drive the provider-neutral `listMachineDirectory`/`readMachineFile`
 * primitives against it. Reuses the branch store + the `MachineHost` seam and
 * the shared view-access check from machine-branches-runtime — no bespoke authz
 * and no direct Sprites-SDK import.
 *
 * Branch scope only: a branch-terminal holds its own Sprite addressed by a
 * stored `sandboxId`, so `host.attach` reconnects to exactly the machine whose
 * checkout the user is browsing. Machine/project-scope browse would resolve
 * through the shared persistent-session acquire path instead and is a separate
 * follow-up.
 */

import { createDbMachineBranchStore } from '@pagespace/lib/services/machines/machine-branches-store';
import type { MachineHandle } from '@pagespace/lib/services/sandbox/machine-host';
import { canViewMachine, getMachineHostForBranches } from './machine-branches-runtime';

export { canViewMachine };

export type ResolveBranchMachineHandleResult =
  | { ok: true; handle: MachineHandle }
  | { ok: false; reason: 'not_found' | 'vanished' };

/**
 * Reconnect to a branch-terminal's Sprite and return its `MachineHandle`.
 * `not_found` = no tracking row for this (terminal, project, branch);
 * `vanished` = the row exists but the Sprite is gone.
 */
export async function resolveBranchMachineHandle({
  terminalId,
  projectName,
  branchName,
}: {
  terminalId: string;
  projectName: string;
  branchName: string;
}): Promise<ResolveBranchMachineHandleResult> {
  const store = await createDbMachineBranchStore();
  const existing = await store.findByName(terminalId, projectName, branchName);
  if (!existing) return { ok: false, reason: 'not_found' };

  const host = await getMachineHostForBranches();
  const handle = await host.attach({ machineId: existing.sandboxId });
  if (!handle) return { ok: false, reason: 'vanished' };
  return { ok: true, handle };
}

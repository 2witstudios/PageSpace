/**
 * Production wiring for the Machine Files browse API (Machine page rebuild,
 * Phase 1 — working-tree file browsing).
 *
 * Resolves a branch-terminal's or the root Machine's LIVE `MachineHandle` so
 * the route can drive the provider-neutral `listMachineDirectory`/
 * `readMachineFile` primitives against it. Reuses the branch store + the
 * `MachineHost` seam and the shared view/edit-access checks from the
 * canonical `machine-access-runtime` — no bespoke authz and no direct
 * Sprites-SDK import.
 *
 * `resolveMachineFilesHandle` is the dispatcher every Files-tab caller should
 * use: branch scope delegates to `resolveBranchMachineHandle` below
 * (unchanged); root scope resolves through `resolveRootMachineHandle`
 * (`./machine-branches-runtime`) — the shared persistent-session read path,
 * never provisioning. Root scope has no tracking row to distinguish "never
 * started" from "gone", so a `null` handle collapses to the single coarser
 * `not_started` reason rather than reusing branch scope's `not_found`/
 * `vanished` split.
 */

import { createDbMachineBranchStore } from '@pagespace/lib/services/machines/machine-branches-store';
import type { MachineHandle } from '@pagespace/lib/services/sandbox/machine-host';
import { getMachineHostForBranches, resolveRootMachineHandle } from './machine-branches-runtime';
import { canViewMachine, canEditMachine } from './machine-access-runtime';

export { canViewMachine, canEditMachine };

export type ResolveBranchMachineHandleResult =
  | { ok: true; handle: MachineHandle }
  | { ok: false; reason: 'not_found' | 'vanished' };

/**
 * Reconnect to a branch-terminal's Sprite and return its `MachineHandle`.
 * `not_found` = no tracking row for this (terminal, project, branch);
 * `vanished` = the row exists but the Sprite is gone.
 */
export async function resolveBranchMachineHandle({
  machineId,
  projectName,
  branchName,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
}): Promise<ResolveBranchMachineHandleResult> {
  const store = await createDbMachineBranchStore();
  const existing = await store.findByName(machineId, projectName, branchName);
  if (!existing) return { ok: false, reason: 'not_found' };

  const host = await getMachineHostForBranches();
  const handle = await host.attach({ machineId: existing.sandboxId });
  if (!handle) return { ok: false, reason: 'vanished' };
  return { ok: true, handle };
}

export type MachineFilesScope =
  | { scope: 'root'; machineId: string }
  | { scope: 'branch'; machineId: string; projectName: string; branchName: string };

export type ResolveMachineFilesHandleResult =
  | { ok: true; handle: MachineHandle }
  | { ok: false; reason: 'not_found' | 'vanished' | 'not_started' };

/**
 * Root-or-branch dispatcher for the Files tab. Branch scope is a pure
 * delegation to `resolveBranchMachineHandle` (byte-for-byte identical
 * behavior); root scope resolves the Machine's own persistent Sprite via
 * `resolveRootMachineHandle`, mapping a `null` (no live session) to
 * `not_started`.
 */
export async function resolveMachineFilesHandle(
  scope: MachineFilesScope,
): Promise<ResolveMachineFilesHandleResult> {
  if (scope.scope === 'branch') return resolveBranchMachineHandle(scope);
  const handle = await resolveRootMachineHandle(scope.machineId);
  return handle ? { ok: true, handle } : { ok: false, reason: 'not_started' };
}

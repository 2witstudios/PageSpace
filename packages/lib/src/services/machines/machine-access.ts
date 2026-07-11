/**
 * Shared Machine (Terminal page) access checks — view vs edit.
 *
 * Extracted from the inline pattern already used by machine-branches-runtime.ts
 * (`findMachinePage` + `canAccessMachine`/`canViewMachine`) and mirrored by
 * agent-terminals-runtime.ts, generalized behind DI so new callers (the
 * upcoming Machine files/diff/settings API routes) import one shared check
 * instead of each writing a slightly different copy. Those two runtimes keep
 * their own inline versions untouched — this is for new code going forward.
 */

import type { PageType } from '../../utils/enums';
import { isMachinePage } from '../../content/page-types.config';

export interface MachineAccessDeps {
  /** Looks up a page's type by id — returns null if the page doesn't exist. */
  findPageType: (machineId: string) => Promise<PageType | null>;
  canUserViewPage: (userId: string, pageId: string) => Promise<boolean>;
  canUserEditPage: (userId: string, pageId: string) => Promise<boolean>;
}

async function isMachine(deps: MachineAccessDeps, machineId: string): Promise<boolean> {
  const type = await deps.findPageType(machineId);
  return type !== null && isMachinePage(type);
}

/** View-level access (e.g. read files/diff/settings) — looser than edit-level. */
export async function canViewMachine(
  deps: MachineAccessDeps,
  actorUserId: string,
  machineId: string,
): Promise<boolean> {
  if (!(await isMachine(deps, machineId))) return false;
  return deps.canUserViewPage(actorUserId, machineId);
}

/** Edit-level access (e.g. mutate settings, write files) — re-check on every call, never cache. */
export async function canEditMachine(
  deps: MachineAccessDeps,
  actorUserId: string,
  machineId: string,
): Promise<boolean> {
  if (!(await isMachine(deps, machineId))) return false;
  return deps.canUserEditPage(actorUserId, machineId);
}

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
import type { MachineSettings } from './machine-settings';

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

/**
 * The actor kinds the Machine Settings access toggles discriminate between.
 * A 'page-agent' is any agent acting under an agent page identity (its own
 * `agentPageId`, or a parent's for a sub-agent); 'global-assistant' is the
 * user-level assistant with no agent page.
 */
export type MachineToggleActor = 'page-agent' | 'global-assistant';

export type MachineToggleDenialCode = 'page_agents_disabled' | 'hidden_from_global';

export type MachineToggleDecision = { allowed: true } | { allowed: false; code: MachineToggleDenialCode };

/**
 * Pure policy for the two per-Machine access toggles persisted by the
 * Settings tab (see `MachineSettings` in machine-settings.ts):
 * `allowPageAgents` gates page-scoped agents, `visibleToGlobalAssistant`
 * gates the global assistant. Each toggle applies ONLY to its own actor kind.
 * This is the single source of the toggle semantics — enforcement boundaries
 * (the AI sandbox machine directory today, any future Machine surface) call
 * this instead of re-deriving the actor-kind × toggle matrix.
 */
export function decideMachineToggleAccess(input: {
  actor: MachineToggleActor;
  settings: Pick<MachineSettings, 'allowPageAgents' | 'visibleToGlobalAssistant'>;
}): MachineToggleDecision {
  if (input.actor === 'page-agent' && !input.settings.allowPageAgents) {
    return { allowed: false, code: 'page_agents_disabled' };
  }
  if (input.actor === 'global-assistant' && !input.settings.visibleToGlobalAssistant) {
    return { allowed: false, code: 'hidden_from_global' };
  }
  return { allowed: true };
}

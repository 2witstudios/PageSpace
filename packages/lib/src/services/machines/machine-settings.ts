/**
 * Machine Settings — the provider-agnostic orchestration behind the Machine
 * page's Settings tab (Terminal — GA, Machine page rebuild).
 *
 * A "Machine" is its backing `PageType.MACHINE` page. Its settings live on
 * that page row: `name` is the page title, `description`/`allowPageAgents` are
 * dedicated Machine columns, and `visibleToGlobalAssistant` reuses the existing
 * page column.
 *
 * NOTE ON THE TWO ACCESS TOGGLES: this route PERSISTS `visibleToGlobalAssistant`
 * and `allowPageAgents` for a Machine; their ENFORCEMENT lives in the machine
 * access gate (`isMachineAccessible` / `resolveGlobalConfiguredMachines`,
 * apps/web/src/lib/ai/tools/sandbox-tools-runtime.ts): `allowPageAgents` denies
 * page-scoped agents the machine's terminal tools, and `visibleToGlobalAssistant`
 * excludes the machine from the global assistant's resolution. For `AI_CHAT`
 * pages `visibleToGlobalAssistant` is separately consulted by agent-awareness.ts.
 * This module is pure orchestration + DI — every DB / Sprite
 * touch is an injected seam (`MachineSettingsStore`, `MachineSpriteTeardown`),
 * so the delete-ordering invariant below is unit-testable without a database or
 * a live Sprite. Route wiring lives in
 * `apps/web/src/lib/machines/machine-settings-runtime.ts`.
 */

/** The Settings-tab-visible state of a Machine. */
export interface MachineSettings {
  name: string;
  description: string | null;
  visibleToGlobalAssistant: boolean;
  allowPageAgents: boolean;
}

/**
 * A partial update. An absent key leaves that field untouched; `description`
 * may be explicitly set to `null` to clear it.
 */
export interface MachineSettingsPatch {
  name?: string;
  description?: string | null;
  visibleToGlobalAssistant?: boolean;
  allowPageAgents?: boolean;
}

/**
 * Persistence seam for a Machine's settings. `getSettings`/`updateSettings`
 * resolve to `null` when the Machine page does not exist (or is trashed);
 * `trashPage` soft-deletes it (reversible via the normal restore path).
 */
export interface MachineSettingsStore {
  getSettings(machineId: string): Promise<MachineSettings | null>;
  updateSettings(machineId: string, patch: MachineSettingsPatch): Promise<MachineSettings | null>;
  trashPage(machineId: string): Promise<void>;
}

/**
 * Tears down the persistent Sprite backing a Machine. Best-effort: `teardown`
 * MAY throw (Sprite already gone, provider error, wrong runtime) — `deleteMachine`
 * treats a throw as a recoverable orphaned-Sprite outcome, never as a failure of
 * the delete as a whole (the page is already trashed by then).
 */
export interface MachineSpriteTeardown {
  teardown(machineId: string): Promise<void>;
}

export interface DeleteMachineDeps {
  machineId: string;
  store: MachineSettingsStore;
  sprite: MachineSpriteTeardown;
}

export type DeleteMachineResult =
  | { ok: true; spriteTornDown: boolean }
  | { ok: false; reason: 'not_found' };

export async function getMachineSettings(input: {
  machineId: string;
  store: MachineSettingsStore;
}): Promise<MachineSettings | null> {
  return input.store.getSettings(input.machineId);
}

export async function updateMachineSettings(input: {
  machineId: string;
  patch: MachineSettingsPatch;
  store: MachineSettingsStore;
}): Promise<MachineSettings | null> {
  return input.store.updateSettings(input.machineId, input.patch);
}

/**
 * Destroy a Machine: trash its page, then tear down its Sprite.
 *
 * The ORDER is a hard requirement, not an implementation detail. We trash the
 * page FIRST because that step is reversible (restore) and immediately hides the
 * Machine from the user. Only THEN do we tear down the Sprite. If teardown fails
 * after the page is already trashed, we are left with an orphaned Sprite — an
 * acceptable, recoverable state a background reconciler can reclaim
 * (`spriteTornDown: false` reports it). The reverse order is NOT acceptable:
 * tearing the Sprite down first and then failing to trash the page leaves a live
 * page pointing at a dead Sprite, with no easy recovery path.
 *
 * The `sprite.teardown` seam frees ALL the compute the Machine spawned — the
 * Machine's own Sprite AND each branch's own Sprite (branch Sprites have no idle
 * reaper, so skipping them would leak microVMs). The dependent metadata ROWS
 * (`machine_projects` / `machine_branches` / `machine_agent_terminals`) are
 * DELIBERATELY LEFT ALONE: they FK-cascade on the page's eventual HARD purge, so a
 * soft (reversible) delete never permanently destroys the user's configured-repo
 * metadata — restoring the page brings that config back (the Sprites re-provision
 * on next use). An earlier revision hard-deleted these rows and was reverted:
 * destroying config during a reversible delete is data loss.
 */
export async function deleteMachine({ machineId, store, sprite }: DeleteMachineDeps): Promise<DeleteMachineResult> {
  const settings = await store.getSettings(machineId);
  if (!settings) return { ok: false, reason: 'not_found' };

  // 1. Trash the page first — reversible, and hides the Machine immediately.
  await store.trashPage(machineId);

  // 2. Then tear down the Machine's own Sprite. A failure here is recoverable
  //    (orphaned Sprite), so it never fails the delete — we just report it.
  let spriteTornDown = true;
  try {
    await sprite.teardown(machineId);
  } catch {
    spriteTornDown = false;
  }

  return { ok: true, spriteTornDown };
}

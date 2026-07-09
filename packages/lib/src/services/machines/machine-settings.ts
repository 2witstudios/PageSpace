/**
 * Machine Settings — the provider-agnostic orchestration behind the Machine
 * page's Settings tab (Terminal — GA, Machine page rebuild).
 *
 * A "Machine" is its backing `PageType.TERMINAL` page. Its settings live on
 * that page row: `name` is the page title, `description`/`allowPageAgents` are
 * dedicated Machine columns, and `visibleToGlobalAssistant` reuses the existing
 * page column (an agent/Machine page opts in or out of the global assistant's
 * view the same way). This module is pure orchestration + DI — every DB / Sprite
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
  getSettings(terminalId: string): Promise<MachineSettings | null>;
  updateSettings(terminalId: string, patch: MachineSettingsPatch): Promise<MachineSettings | null>;
  trashPage(terminalId: string): Promise<void>;
}

/**
 * Tears down the persistent Sprite backing a Machine. Best-effort: `teardown`
 * MAY throw (Sprite already gone, provider error, wrong runtime) — `deleteMachine`
 * treats a throw as a recoverable orphaned-Sprite outcome, never as a failure of
 * the delete as a whole (the page is already trashed by then).
 */
export interface MachineSpriteTeardown {
  teardown(terminalId: string): Promise<void>;
}

export interface DeleteMachineDeps {
  terminalId: string;
  store: MachineSettingsStore;
  sprite: MachineSpriteTeardown;
}

export type DeleteMachineResult =
  | { ok: true; spriteTornDown: boolean }
  | { ok: false; reason: 'not_found' };

export async function getMachineSettings(input: {
  terminalId: string;
  store: MachineSettingsStore;
}): Promise<MachineSettings | null> {
  return input.store.getSettings(input.terminalId);
}

export async function updateMachineSettings(input: {
  terminalId: string;
  patch: MachineSettingsPatch;
  store: MachineSettingsStore;
}): Promise<MachineSettings | null> {
  return input.store.updateSettings(input.terminalId, input.patch);
}

/**
 * Destroy a Machine: trash its page, then tear down its Sprite.
 *
 * The ORDER is a hard requirement, not an implementation detail. We trash the
 * page FIRST because that step is reversible (restore) and immediately hides the
 * Machine from the user. Only THEN do we tear down the Sprite. If teardown fails
 * after the page is already trashed, we are left with an orphaned Sprite — an
 * acceptable, recoverable state a background reconciler can reclaim (`spriteTornDown:
 * false` reports it). The reverse order is NOT acceptable: tearing the Sprite down
 * first and then failing to trash the page leaves a live page pointing at a dead
 * Sprite, with no easy recovery path.
 */
export async function deleteMachine({ terminalId, store, sprite }: DeleteMachineDeps): Promise<DeleteMachineResult> {
  const settings = await store.getSettings(terminalId);
  if (!settings) return { ok: false, reason: 'not_found' };

  // 1. Trash the page first — reversible, and hides the Machine immediately.
  await store.trashPage(terminalId);

  // 2. Then tear down the Sprite. A failure here is recoverable (orphaned
  //    Sprite), so it never fails the delete — we just report it wasn't reclaimed.
  let spriteTornDown = true;
  try {
    await sprite.teardown(terminalId);
  } catch {
    spriteTornDown = false;
  }

  return { ok: true, spriteTornDown };
}

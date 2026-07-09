/**
 * Machine Settings — the provider-agnostic orchestration behind the Machine
 * page's Settings tab (Terminal — GA, Machine page rebuild).
 *
 * A "Machine" is its backing `PageType.TERMINAL` page. Its settings live on
 * that page row: `name` is the page title, `description`/`allowPageAgents` are
 * dedicated Machine columns, and `visibleToGlobalAssistant` reuses the existing
 * page column (an agent/Machine page opts in or out of the global assistant's
 * view the same way). This module is pure orchestration + DI — every DB / Sprite
 * touch is an injected seam (`MachineSettingsStore`, `MachineSpriteTeardown`,
 * `MachineDependentsPurge`), so the delete-ordering invariant below is
 * unit-testable without a database or a live Sprite. Route wiring lives in
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

/**
 * Purges the Machine's dependent metadata (projects, branches, agent terminals)
 * and any Sprites those rows own. Those rows FK-cascade only on a HARD page
 * delete, so without this they would survive the soft-delete (trash) window
 * pointing at a torn-down Sprite — resurfacing stale on restore, with the unique
 * `(terminalId, name)` constraint then blocking re-adding the same project. Also
 * best-effort: a failure leaves rows that the eventual hard purge still cascades.
 */
export interface MachineDependentsPurge {
  purge(terminalId: string): Promise<void>;
}

export interface DeleteMachineDeps {
  terminalId: string;
  store: MachineSettingsStore;
  sprite: MachineSpriteTeardown;
  dependents: MachineDependentsPurge;
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
 * Destroy a Machine: trash its page, then tear down its Sprite, then purge its
 * dependent metadata.
 *
 * The page-trash-before-Sprite-teardown ORDER is a hard requirement, not an
 * implementation detail. We trash the page FIRST because that step is reversible
 * (restore) and immediately hides the Machine from the user. Only THEN do we tear
 * down the Sprite. If teardown fails after the page is already trashed, we are
 * left with an orphaned Sprite — an acceptable, recoverable state a background
 * reconciler can reclaim (`spriteTornDown: false` reports it). The reverse order
 * is NOT acceptable: tearing the Sprite down first and then failing to trash the
 * page leaves a live page pointing at a dead Sprite, with no easy recovery path.
 *
 * Dependent-metadata purge runs last and is likewise best-effort: it keeps the
 * projects/branches/agent-terminals rows consistent with the now-destroyed Sprite
 * so a later restore is a clean slate rather than a list of dead pointers.
 */
export async function deleteMachine({ terminalId, store, sprite, dependents }: DeleteMachineDeps): Promise<DeleteMachineResult> {
  const settings = await store.getSettings(terminalId);
  if (!settings) return { ok: false, reason: 'not_found' };

  // 1. Trash the page first — reversible, and hides the Machine immediately.
  await store.trashPage(terminalId);

  // 2. Then tear down the Machine's own Sprite. A failure here is recoverable
  //    (orphaned Sprite), so it never fails the delete — we just report it.
  let spriteTornDown = true;
  try {
    await sprite.teardown(terminalId);
  } catch {
    spriteTornDown = false;
  }

  // 3. Purge dependent metadata (and branch Sprites) so a restore doesn't
  //    resurface stale rows. Best-effort: the eventual hard purge cascades these
  //    anyway, so a failure must not fail an already-trashed, Sprite-torn-down delete.
  try {
    await dependents.purge(terminalId);
  } catch {
    // Left for the hard-purge FK cascade to clean up.
  }

  return { ok: true, spriteTornDown };
}

/**
 * How large each memory page is allowed to get.
 *
 * ── Why this is one file rather than three constants ─────────────────────────
 * Three separate places act on these numbers, and they only work if all three
 * agree:
 *
 *   1. `compaction-service` shrinks a page once it exceeds `max`.
 *   2. `integration-service` refuses a rewrite that would exceed `max`.
 *   3. `personalization-utils` truncates at `max` when building the prompt.
 *
 * Drift between them is silent and self-perpetuating. If compaction's ceiling
 * were higher than the write guard's, every compaction result would be refused
 * by the guard and the page would stay over budget forever, with a "compacted"
 * log line each night. If injection's were lower, the profile the user reads in
 * their drive would quietly differ from the one the AI actually sees.
 *
 * None of that fails loudly, so the numbers live here once.
 */

export type MemoryField = 'bio' | 'writingStyle' | 'rules';

/**
 * Per-field ceiling, in characters.
 *
 * `bio` gets more room because it is prose about a person; the behavioural
 * fields are lists of instructions and stay tighter. The absolute values are
 * chosen so a full profile reads as a page of context rather than a dossier —
 * the pre-rewrite design settled at ~14,000 characters per field, which is what
 * this replaces.
 */
export const MAX_FIELD_LENGTH: Record<MemoryField, number> = {
  bio: 3000,
  writingStyle: 2500,
  rules: 2500,
};

/**
 * What compaction aims for once it fires: 70% of the ceiling.
 *
 * Compacting exactly to the ceiling would re-trigger on the next addition, so
 * the gap is the headroom that stops the cron compacting every single night.
 */
export const COMPACTION_TARGET_RATIO = 0.7;

export function compactionTarget(field: MemoryField): number {
  return Math.floor(MAX_FIELD_LENGTH[field] * COMPACTION_TARGET_RATIO);
}

/**
 * Ceiling for the whole injected block.
 *
 * Deliberately BELOW the sum of the per-field budgets (3000 + 2500 + 2500 =
 * 8000). If it equalled that sum the total check could never fire, since three
 * already-truncated fields would always fit — a guard that reads as protection
 * while being dead code. A profile using every field in full is over budget,
 * and the priority order in `personalization-utils` decides what survives.
 */
export const MAX_TOTAL_INJECTION_LENGTH = 6000;

/**
 * Pure helpers for the enabledTools trash/restore-verb backfill.
 *
 * Sub-PR 1 split the discriminated `trash`/`restore` AI tools into explicit
 * per-entity verbs (`trash_page`, `trash_drive`, `restore_page`,
 * `restore_drive`). Per-page AI agents (AI_CHAT pages) store a curated
 * allowlist of tool names in `pages.enabledTools`. Before `trash`/`restore`
 * are removed (sub-PR 3), every agent currently allowed `trash` must also be
 * granted the trash verbs, and every agent allowed `restore` must also be
 * granted the restore verbs, so it does not lose trash/restore ability.
 *
 * The runtime grants a tool purely via `Array.includes(name)`, so a legacy or
 * mixed array (e.g. containing non-string junk alongside `"trash"`) still
 * grants `trash` at runtime. This transform mirrors that: it acts on any array
 * that contains the string `"trash"` or `"restore"`, regardless of what else is
 * in it, and preserves every existing entry untouched.
 *
 * This module is intentionally dependency-free so it can be unit-tested without
 * touching the database.
 */

/** The tools whose presence triggers the backfill. */
export const TRASH_TRIGGER = 'trash';
export const RESTORE_TRIGGER = 'restore';

/** The verb tools that must be granted alongside `trash`. */
export const TRASH_VERB_TOOLS = ['trash_page', 'trash_drive'] as const;

/** The verb tools that must be granted alongside `restore`. */
export const RESTORE_VERB_TOOLS = ['restore_page', 'restore_drive'] as const;

/**
 * Add the trash/restore verb tools to an enabledTools allowlist.
 *
 * Mirrors runtime allowlist semantics (`Array.includes`):
 * - If the array contains the string `"trash"`, the missing trash verbs
 *   (in {@link TRASH_VERB_TOOLS} order) are appended.
 * - If the array contains the string `"restore"`, the missing restore verbs
 *   (in {@link RESTORE_VERB_TOOLS} order) are appended.
 * - If it contains neither trigger, it is returned unchanged.
 * - All existing entries — including any non-string values — are preserved in
 *   place; nothing is dropped or reordered.
 * - Idempotent: a second call on the result produces no further changes.
 */
export function addTrashVerbTools(tools: unknown[]): unknown[] {
  const missing: string[] = [];

  if (tools.includes(TRASH_TRIGGER)) {
    missing.push(...TRASH_VERB_TOOLS.filter((verb) => !tools.includes(verb)));
  }

  if (tools.includes(RESTORE_TRIGGER)) {
    missing.push(...RESTORE_VERB_TOOLS.filter((verb) => !tools.includes(verb)));
  }

  if (missing.length === 0) {
    return tools;
  }

  return [...tools, ...missing];
}

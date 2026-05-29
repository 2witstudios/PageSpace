/**
 * Pure helpers for the enabledTools task-verb backfill.
 *
 * Sub-PR 1 split the monolithic `update_task` AI tool into explicit verbs
 * (`create_task`, `delete_task`, `reorder_task`). Per-page AI agents
 * (AI_CHAT pages) store a curated allowlist of tool names in
 * `pages.enabledTools`. Before `update_task` is narrowed to field-only edits
 * (sub-PR 3), every agent currently allowed `update_task` must also be granted
 * the new verbs so it does not lose create/delete/reorder ability.
 *
 * The runtime grants a tool purely via `Array.includes(name)`, so a legacy or
 * mixed array (e.g. containing non-string junk alongside `"update_task"`) still
 * grants `update_task` at runtime. This transform mirrors that: it acts on any
 * array that contains the string `"update_task"`, regardless of what else is in
 * it, and preserves every existing entry untouched.
 *
 * This module is intentionally dependency-free so it can be unit-tested without
 * touching the database.
 */

/** The tool whose presence triggers the backfill. */
export const TRIGGER_TOOL = 'update_task';

/** The verb tools that must be granted alongside `update_task`. */
export const TASK_VERB_TOOLS = ['create_task', 'delete_task', 'reorder_task'] as const;

/**
 * Add the task verb tools to an enabledTools allowlist when it grants
 * `update_task`.
 *
 * Mirrors runtime allowlist semantics (`Array.includes`):
 * - If the array does not contain the string `"update_task"`, it is returned
 *   unchanged.
 * - Otherwise the missing verbs are appended (in {@link TASK_VERB_TOOLS}
 *   order). All existing entries — including any non-string values — are
 *   preserved in place; nothing is dropped or reordered.
 * - Idempotent: a second call on the result produces no further changes.
 */
export function addTaskVerbTools(tools: unknown[]): unknown[] {
  if (!tools.includes(TRIGGER_TOOL)) {
    return tools;
  }

  const missing = TASK_VERB_TOOLS.filter((verb) => !tools.includes(verb));
  if (missing.length === 0) {
    return tools;
  }

  return [...tools, ...missing];
}

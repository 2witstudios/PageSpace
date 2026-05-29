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
 * - If `update_task` is absent, the array is returned unchanged.
 * - Existing entries and their order are preserved; only missing verbs are
 *   appended (in {@link TASK_VERB_TOOLS} order).
 * - Idempotent: a second call on the result produces no further changes.
 */
export function addTaskVerbTools(tools: string[]): string[] {
  if (!tools.includes(TRIGGER_TOOL)) {
    return tools;
  }

  const missing = TASK_VERB_TOOLS.filter((verb) => !tools.includes(verb));
  if (missing.length === 0) {
    return tools;
  }

  return [...tools, ...missing];
}

/**
 * Type guard for a JSONB `enabledTools` value that is a plain array of strings.
 * `enabledTools` is nullable (unrestricted agents) and historically loosely
 * typed, so callers must validate before transforming.
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

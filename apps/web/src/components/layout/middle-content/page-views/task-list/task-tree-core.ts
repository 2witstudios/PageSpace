/**
 * Pure core for the nested task tree. No React, no fetching — everything here is
 * a total function over plain data so it can be tested directly and mutated to
 * prove the tests actually hold.
 *
 * The renderer is component recursion (TaskRowGroup), not a flat list: each
 * expanded node owns its own SWR cache, and a hook cannot be called at variable
 * depth. What lives here is the algebra that recursion needs — path identity,
 * expansion state, depth limits, and the status-vocabulary reconciliation that
 * keeps a nested dropdown from producing a slug the server will reject.
 */

import type { TaskItem, TaskStatusConfig } from './task-list-types';

/**
 * Number of <th> cells in the desktop task table header. Defined in
 * ./table-columns and re-exported here so nested-row components can span the
 * full width without importing the whole view.
 */
export { TASK_TABLE_COLUMN_COUNT } from './table-columns';

/**
 * Hard ceiling on how deep expansion goes. Each expanded node mounts its own
 * paginated fetch against a route with lazy write side effects, so unbounded
 * recursion is unbounded fan-out. Past the limit a row simply has no chevron —
 * the subtree is still reachable by opening the task's own page, which renders
 * it as a list in its own right, just not inline. (There is no "Open task"
 * affordance; an earlier version of this comment claimed one.)
 */
export const MAX_TASK_DEPTH = 5;

/**
 * Deepest level at which a task may be CREATED. One below the expansion
 * ceiling, so anything created is still reachable inline.
 */
export const MAX_ADDABLE_DEPTH = 4;

/**
 * May a task be created at this depth?
 *
 * Expressed once, in terms of the depth of the task being CREATED, because the
 * two call sites naturally hold different depths — a row knows its own, while
 * the child list knows its children's — and comparing the two raw expressions
 * side by side reads like an off-by-one even when it isn't.
 */
export const canAddSubTaskAt = (createdDepth: number): boolean =>
  createdDepth <= MAX_ADDABLE_DEPTH;

/** Pixels of indent added per level of nesting. */
export const DEPTH_INDENT_PX = 20;

/**
 * Identity of a rendered node: the root list's page id followed by one task id
 * per level. Not a bare task id.
 *
 * A page tree is acyclic, so today the same task id genuinely cannot appear at
 * two depths at once. The path is still the right key: it stays correct if a
 * future filtered or searched view renders the same subtree in two places, and
 * it gives React an unambiguous `key`.
 *
 * Note what collapsing does NOT do: `toggleNodePath` removes one path, so a
 * collapsed node keeps its descendants' paths in the set and re-expanding
 * restores the shape it had. Nothing prunes a subtree today.
 */
export type TaskNodePath = string;

const PATH_SEPARATOR = '/';

export const rootNodePath = (listPageId: string): TaskNodePath => listPageId;

export const makeNodePath = (parentPath: TaskNodePath, taskId: string): TaskNodePath =>
  `${parentPath}${PATH_SEPARATOR}${taskId}`;

export const isNodeExpanded = (
  expanded: ReadonlySet<TaskNodePath>,
  path: TaskNodePath,
): boolean => expanded.has(path);

/** Immutable toggle — never mutates the input set. */
export const toggleNodePath = (
  expanded: ReadonlySet<TaskNodePath>,
  path: TaskNodePath,
): Set<TaskNodePath> => {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
};

/**
 * Depth-aware form of `canExpandTask`. Same two conditions — the task has a
 * linked page and either its own document content or at least one sub-task —
 * plus the depth ceiling.
 */
export const canExpandNode = (
  task: Pick<TaskItem, 'hasContent' | 'subTaskCount' | 'pageId'>,
  depth: number,
  maxDepth: number = MAX_TASK_DEPTH,
): boolean => {
  if (depth >= maxDepth) return false;
  return !!task.pageId && (!!task.hasContent || (task.subTaskCount ?? 0) > 0);
};

/**
 * Indent for a nested row. Applied to the inner element of the title cell, not
 * to the <tr> — padding on a table row is not rendered — and inline rather than
 * as a Tailwind class because the value is dynamic.
 */
export const depthIndentStyle = (depth: number): { paddingLeft: string } => ({
  paddingLeft: `${Math.max(0, depth) * DEPTH_INDENT_PX}px`,
});

/**
 * Which status vocabulary a nested row may safely render.
 *
 * Status configs are per-task-list, so a sub-task's statuses come from its own
 * parent task's list. The epic's decision is that a nested row should show the
 * ROOT list's vocabulary — but PATCH validates the submitted slug against the
 * configs of the list named in its URL, so showing a root slug the node's own
 * list does not define produces a 400.
 *
 * Newly created sub-lists inherit their ancestor's vocabulary at seed time
 * (seedInheritedTaskStatusConfigs), which makes the two sides identical and this
 * function a no-op. It exists for sub-lists seeded before that landed: when any
 * root slug is missing from the node's list, fall back to the node's own configs
 * — visually inconsistent, but every option in the dropdown is one the server
 * will accept.
 */
export const resolveNodeStatusConfigs = (
  rootConfigs: readonly TaskStatusConfig[],
  nodeConfigs: readonly TaskStatusConfig[],
): readonly TaskStatusConfig[] => {
  if (rootConfigs.length === 0) return nodeConfigs;
  if (nodeConfigs.length === 0) return nodeConfigs;
  const nodeSlugs = new Set(nodeConfigs.map((c) => c.slug));
  const everyRootSlugExists = rootConfigs.every((c) => nodeSlugs.has(c.slug));
  return everyRootSlugExists ? rootConfigs : nodeConfigs;
};

/**
 * Sub-task progress for a row badge. Null — not "0/0" — when the task has no
 * sub-tasks, so callers render nothing rather than a meaningless ratio.
 */
export const formatSubTaskProgress = (
  task: Pick<TaskItem, 'subTaskCount' | 'subTaskCompletedCount'>,
): { label: string; ratio: number } | null => {
  const total = task.subTaskCount ?? 0;
  if (total <= 0) return null;
  const completed = Math.min(Math.max(task.subTaskCompletedCount ?? 0, 0), total);
  return { label: `${completed}/${total}`, ratio: completed / total };
};

/**
 * Number of <th> cells in the desktop task table header.
 *
 * Every colSpan in the task list derives from it, so adding a column to the
 * header cannot silently leave the expansion / document / new-task rows
 * spanning the wrong width. It lives in its own module rather than in
 * TaskListView so pure cores and nested-row components can import it without
 * dragging the whole view (and its SWR/dnd-kit imports) into their module graph.
 */
export const TASK_TABLE_COLUMN_COUNT = 8;

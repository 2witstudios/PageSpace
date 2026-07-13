import type { ToolExecutionContext } from '../core/types';

/**
 * Resolve the page a tool should act on when the LLM omits `pageId`: the
 * agent's own in-turn focus (currentWorkingPage, e.g. after create_page)
 * wins over the page the user was viewing when the turn started
 * (locationContext.currentPage) — see ToolExecutionContext.currentWorkingPage.
 *
 * Only wire this into tools where "act on the page in view" is a safe,
 * unambiguous default — never destructive/trash/restore tools, and never
 * tools whose `pageId`-like argument means something other than "the page
 * to operate on" (e.g. read_conversation's pageId selects which agent's
 * history to read).
 */
export function resolveDefaultPageId(context: ToolExecutionContext | undefined): string | undefined {
  return context?.currentWorkingPage?.id ?? context?.locationContext?.currentPage?.id;
}

/**
 * Resolve an omitted `pageId` tool argument the same way across every page
 * tool that supports the default, or throw the identical, tool-agnostic
 * error message. Centralizing this keeps the 6 call sites (read_page,
 * replace_lines, rename_page, move_page, insert_content, edit_sheet_cells)
 * from silently drifting if the fallback or its wording ever needs to change.
 */
export function resolveOrThrowPageId(
  pageIdArg: string | undefined,
  context: ToolExecutionContext | undefined,
): string {
  const pageId = pageIdArg ?? resolveDefaultPageId(context);
  if (!pageId) {
    throw new Error('pageId is required: no page is currently in view and none was provided.');
  }
  return pageId;
}

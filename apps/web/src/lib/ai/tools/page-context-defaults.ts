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

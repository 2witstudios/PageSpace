/**
 * Active-plan prompt section.
 *
 * A conversation bound to a plan page (`conversations.planPageId`, set by the
 * `set_plan` tool) carries a pointer to it in the STABLE system section, the
 * same volatility class and the same trade as Agent Memory: the value changes
 * only when the agent explicitly rebinds — never on navigation — so it costs
 * one justified cache invalidation per plan change.
 *
 * The stable half is not an optimization here, it is the requirement. The
 * compaction summary at ModelMessages[0] is lossy, so a pointer living in the
 * message stream gets summarized away exactly when it is most needed (the same
 * reason TasksDropdown's message-derived task binding empties on truncation).
 * The system prompt is never compacted, so a pointer placed here survives by
 * construction — and a re-read of the page is exact where a summary only
 * approximates.
 *
 * Fail-open throughout: a broken lookup must degrade to "no plan section",
 * never fail the turn.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { pages } from '@pagespace/db/schema/core';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { clipDescription } from '@pagespace/lib/commands/command-core';

/**
 * A page title is user-authored and lands verbatim in the system prompt, so it
 * must not be able to forge prompt structure — a title containing newlines
 * could otherwise inject a fake section. Same sanitizer, and same reasoning, as
 * every other prompt surface that renders user data.
 */
const PLAN_TITLE_CHAR_LIMIT = 200;

export interface ActivePlan {
  pageId: string;
  title: string;
}

/**
 * Resolve the plan bound to `conversationId`, or null when unbound, trashed,
 * no longer viewable, or on any error.
 *
 * Access is re-checked at use rather than trusted from bind time: a plan page
 * can be moved or have its permissions revoked after `set_plan` ran, and a
 * pointer the caller can no longer open must not keep appearing in their prompt.
 */
export async function getActivePlan(
  conversationId: string | undefined,
  userId: string,
): Promise<ActivePlan | null> {
  if (!conversationId) return null;
  try {
    const [row] = await db
      .select({
        pageId: pages.id,
        title: pages.title,
        isTrashed: pages.isTrashed,
      })
      .from(conversations)
      .innerJoin(pages, eq(conversations.planPageId, pages.id))
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!row || row.isTrashed) return null;
    if (!(await canUserViewPage(userId, row.pageId))) return null;

    return { pageId: row.pageId, title: row.title };
  } catch {
    return null;
  }
}

/**
 * The `ACTIVE PLAN:` section appended to the stable system prompt. Empty string
 * when unbound, so a conversation that never plans pays zero standing tokens.
 *
 * Deterministic: same input → byte-identical output. That property is what lets
 * this live in the cached prefix at all, and it is covered by a test.
 */
export function buildActivePlanPrompt(plan: ActivePlan | null): string {
  if (!plan) return '';

  return [
    '',
    '',
    'ACTIVE PLAN:',
    `This conversation is working against the plan page "${clipDescription(plan.title, PLAN_TITLE_CHAR_LIMIT)}" (pageId: ${plan.pageId}).`,
    'If a conversation summary appears above, or you are resuming after a gap, re-read that page with read_page before continuing — the page is authoritative, your recollection of it is not.',
    'Keep it current as the plan changes, and call clear_plan when the work is finished or abandoned.',
  ].join('\n');
}

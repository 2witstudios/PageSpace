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
  /** The plan page's drive — unused by the prompt, needed by the chip's link. */
  driveId: string;
}

/**
 * Resolve the plan bound to `conversationId`, or null when unbound, trashed,
 * not visible to the caller, or on any error.
 *
 * Access is re-checked at use rather than trusted from bind time: a plan page
 * can be moved or have its permissions revoked after `set_plan` ran, and a
 * pointer the caller can no longer open must not keep appearing in their prompt.
 *
 * `canView` is the authorization check, injected so this module stays free of
 * auth plumbing. It defaults to the USER-level check, which is correct only for
 * session-authenticated surfaces (the Global Assistant). The page-chat route
 * also accepts scoped MCP and OAuth tokens, and must pass
 * `canPrincipalViewPage` instead — "can this human see it" is strictly wider
 * than "may this token reach it".
 *
 * That distinction matters more here than for the neighbouring Agent Memory
 * section, which gets away with a bare user-level check: an Agent Memory page is
 * by construction a child of the agent page, hence always in the chat's own
 * drive, whereas a plan binding can point at a page in a completely different
 * drive. Without a principal-aware check, a token scoped to drive A would see
 * the title and id of a plan the user bound in drive B.
 */
export async function getActivePlan(
  conversationId: string | undefined,
  userId: string,
  canView: (pageId: string) => Promise<boolean> = (pageId) => canUserViewPage(userId, pageId),
): Promise<ActivePlan | null> {
  if (!conversationId) return null;
  try {
    return await resolveBoundPlan(conversationId, userId, canView);
  } catch {
    return null;
  }
}

/**
 * THE RULE, without an error policy: join the conversation to its plan page,
 * suppress it when trashed or when the caller cannot view it.
 *
 * Separate from {@link getActivePlan} because the two consumers need the same
 * rule and DIFFERENT failure behaviour, and that difference is deliberate:
 *
 *  - the prompt section must never fail a turn, so it swallows (above);
 *  - `GET /api/ai/conversations/:id/plan` must NOT swallow. A chip that renders
 *    "no plan" because a query blew up is lying about durable state the user
 *    can act on; a 500 lets the client show that it does not know.
 *
 * Before this split the route implemented the rule a second time, with its own
 * join and its own null semantics. One rule, two edges, each explicit about
 * what it does with a failure.
 */
export async function resolveBoundPlan(
  conversationId: string,
  userId: string,
  canView: (pageId: string) => Promise<boolean> = (pageId) => canUserViewPage(userId, pageId),
): Promise<ActivePlan | null> {
  const [row] = await db
    .select({
      pageId: pages.id,
      title: pages.title,
      driveId: pages.driveId,
      isTrashed: pages.isTrashed,
    })
    .from(conversations)
    .innerJoin(pages, eq(conversations.planPageId, pages.id))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!row || row.isTrashed) return null;
  if (!(await canView(row.pageId))) return null;

  return { pageId: row.pageId, title: row.title, driveId: row.driveId };
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

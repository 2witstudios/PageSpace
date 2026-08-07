/**
 * HOW A UNIFIED `messages` ROW NAMES ITS PAGE — one definition, shared by
 * every page-scoped reader (epic "Agent-Session Single Source of Truth",
 * Phase 4 / D6, reader cutover).
 *
 * `chat_messages` had a `pageId` column and every page-scoped query said
 * `pageId = X`. The unified table's authoritative page link is
 * `conversations.contextId` for a `type='page'` conversation, so the readers
 * translate that predicate into a JOIN. Getting that translation subtly
 * different in each of the ~8 call sites is the failure mode this module
 * exists to prevent, so the rule lives here and nowhere else.
 *
 * A leaf module on purpose: schema + operators only, no repository imports, so
 * anything from a route to `page-service.ts` can depend on it without pulling
 * the write path in behind it.
 */

import { eq, and, or, sql, type SQL } from '@pagespace/db/operators';
import { conversations, messages } from '@pagespace/db/schema/conversations';

/**
 * The page a unified row belongs to, derived at read time.
 *
 * PRIMARY: `conversations.contextId` when `conversations.type = 'page'` — the
 * end-state authority (D6: "no `pageId` in the end state"), indexed by
 * `conversations_context_id_idx`.
 *
 * FALLBACK: the transitional `messages.pageId`, and ONLY for a conversation
 * that is not `type='page'`. The one shape that needs it is `type='client'` —
 * an API-managed thread (`/api/v1/chat/completions`) whose `contextId` is a
 * DRIVE id or null, while its rows still name the agent page they ran against.
 * Before this cutover those rows answered `chat_messages.pageId`; dropping
 * them to null here would 404 a pagespace-cli thread's own edit/delete route.
 *
 * The column is scheduled for deletion (Phase 4 PR 15), which is exactly when
 * `type='client'`'s page link has to be given a real home. Recorded here so
 * that PR cannot miss it.
 *
 * A FUNCTION, not a module-level constant: building the fragment eagerly would
 * make every module that transitively imports the message repository require a
 * live `sql` at import time — which is a real constraint on ~20 unit tests that
 * mock `@pagespace/db/operators` and never touch a page-scoped read.
 */
export function derivedPageId(): SQL<string | null> {
  return sql<string | null>`CASE WHEN ${conversations.type} = 'page' THEN ${conversations.contextId} ELSE ${messages.pageId} END`;
}

/**
 * "This row belongs to page X" for a page-SCOPED reader, over the unified
 * table — the exact translation of the legacy `chat_messages.pageId = X`.
 *
 * Requires the caller to `.innerJoin(conversations, eq(conversations.id,
 * messages.conversationId))`. Safe for every row: `messages.conversationId`
 * carries a validated FK, so the inner join drops nothing.
 *
 * Two disjuncts, for the same reason `derivedPageId` has two branches. A
 * row cannot be caught by the wrong one: migration 0248 derived every page
 * conversation's `contextId` FROM `chat_messages.pageId` after auditing the
 * mapping 1:1, and a drive id can never equal a page id.
 */
export function unifiedPageScope(pageId: string): SQL {
  return or(
    and(eq(conversations.type, 'page'), eq(conversations.contextId, pageId)),
    eq(messages.pageId, pageId),
  )!;
}

/**
 * The raw-SQL twin of `unifiedPageScope`, for the hand-written aggregate
 * queries that cannot use the drizzle builder (the page-agent conversation
 * listing and its count). Expects the caller's FROM list to alias `messages`
 * as `m` and its joined `conversations` row as `pc`.
 */
export function unifiedPageScopeSql(pageId: string): SQL {
  return sql`((pc.type = 'page' AND pc."contextId" = ${pageId}) OR m."pageId" = ${pageId})`;
}

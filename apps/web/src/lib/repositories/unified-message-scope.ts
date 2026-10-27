/**
 * HOW A UNIFIED `messages` ROW NAMES ITS PAGE — one definition, shared by
 * every page-scoped reader (epic "Agent-Session Single Source of Truth",
 * Phase 4 / D6).
 *
 * `chat_messages` had a `pageId` column and every page-scoped query said
 * `pageId = X`. The unified table has no such column — a row's page is its
 * CONVERSATION's page — so the readers translate that predicate into a JOIN.
 * Getting that translation subtly different in each of the ~8 call sites is
 * the failure mode this module exists to prevent, so the rule lives here and
 * nowhere else.
 *
 * A leaf module on purpose: schema + operators only, no repository imports, so
 * anything from a route to `page-service.ts` can depend on it without pulling
 * the write path in behind it.
 */

import { eq, and, or, sql, type SQL } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';

/**
 * The page a unified row belongs to, derived at read time.
 *
 * TWO conversation kinds name a page, and each names it in its own column —
 * one owner per fact, keyed by `type`:
 *
 *   `type='page'`   → `conversations.contextId`, indexed by
 *                     `conversations_context_id_idx`. The in-app page chat.
 *   `type='client'` → `conversations.agentPageId`, indexed by
 *                     `conversations_agent_page_id_idx`. The API-managed
 *                     threads `POST /api/v1/conversations` mints, whose
 *                     `contextId` is a DRIVE (and is load-bearing there: it is
 *                     what a drive-scoped MCP token is authorized against), so
 *                     their page needs a column of its own.
 *
 * Everything else — `type='global'`, `type='drive'` — derives NULL, and a NULL
 * here is what the page-scoped edit/delete routes 404 on: a page route must
 * never become a second door onto a global-assistant message.
 *
 * Until PR 15 the `type='client'` branch read the transitional
 * `messages.pageId`, copied onto every row of the thread. Moving it to the
 * conversation is the same fact with one owner instead of N — and it fixed a
 * latent truncation bug on the way, since a thread whose requests named two
 * different agent pages used to load only the subset matching the request's.
 *
 * A FUNCTION, not a module-level constant: building the fragment eagerly would
 * make every module that transitively imports the message repository require a
 * live `sql` at import time — which is a real constraint on ~20 unit tests that
 * mock `@pagespace/db/operators` and never touch a page-scoped read.
 */
export function derivedPageId(): SQL<string | null> {
  return sql<string | null>`CASE WHEN ${conversations.type} = 'page' THEN ${conversations.contextId} WHEN ${conversations.type} = 'client' THEN ${conversations.agentPageId} END`;
}

/**
 * The ROW-LEVEL twin of {@link derivedPageId}, re-exported here so the two
 * renderings of one rule are reachable from the module that owns it.
 *
 * It lives in `@pagespace/lib/conversations/conversation-page` rather than in
 * this file because the `'use client'` directory listener needs it too, and
 * this module imports the schema and the operators — depending on it from a
 * browser bundle would drag Drizzle in. See that module for why it exists at
 * all (six call sites, three different answers).
 *
 * `parity.test.ts` beside this file asserts the two agree on every `type`.
 */
export { conversationPageId, type ConversationPageSubject } from '@pagespace/lib/conversations/conversation-page';

/**
 * "This row belongs to page X" for a page-SCOPED reader, over the unified
 * table — the exact translation of the legacy `chat_messages.pageId = X`.
 *
 * Requires the caller to `.innerJoin(conversations, eq(conversations.id,
 * messages.conversationId))`. Safe for every row: `messages.conversationId`
 * carries a validated FK, so the inner join drops nothing.
 *
 * Two disjuncts, for the same reason `derivedPageId` has two branches. A row
 * cannot be caught by the wrong one — the two columns are disjoint by `type`.
 *
 * Deliberately WIDER than the "page conversations only" form the internal
 * readers use (Phase 4 PR 11: session transcripts, memory discovery, pulse,
 * search). These are the paths a user drives — the page chat history load, the
 * consult context, the edit/delete routes, page teardown — and they keep exact
 * behavioural parity with `chat_messages.pageId = X`, which caught client
 * threads too. The difference between the two forms is asserted, not assumed,
 * by `__tests__/unified-reader-parity.integration.test.ts`.
 */
export function unifiedPageScope(pageId: string): SQL {
  return or(
    and(eq(conversations.type, 'page'), eq(conversations.contextId, pageId)),
    and(eq(conversations.type, 'client'), eq(conversations.agentPageId, pageId)),
  )!;
}

/**
 * The raw-SQL twin of `unifiedPageScope`, for the hand-written aggregate
 * queries that cannot use the drizzle builder (the page-agent conversation
 * listing and its count). Expects the caller's joined `conversations` row to
 * be aliased `pc`.
 */
export function unifiedPageScopeSql(pageId: string): SQL {
  return sql`((pc.type = 'page' AND pc."contextId" = ${pageId}) OR (pc.type = 'client' AND pc."agentPageId" = ${pageId}))`;
}

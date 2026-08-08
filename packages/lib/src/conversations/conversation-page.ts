/**
 * WHICH PAGE A CONVERSATION NAMES — the pure half of the rule whose SQL half is
 * `derivedPageId()` in `apps/web/src/lib/repositories/unified-message-scope.ts`.
 *
 * That module's docblock says getting this translation subtly different at each
 * call site is the failure mode it exists to prevent. It was — but only for
 * query builders: it offered a `SQL` fragment and nothing else, so every reader
 * holding a plain ROW had to re-spell the rule by hand. Six did, and three
 * different answers were in circulation (review finding):
 *
 *   - five wrote `type === 'page' ? contextId : null`, dropping the `client`
 *     branch, so every API-managed thread came back unlabelled;
 *   - one mapped `type='drive'` onto `agentPageId`, which the SQL maps to NULL.
 *
 * So the rule lives here, in a leaf with NO imports at all. That is what lets
 * the `'use client'` directory listener and the server runtimes share one
 * definition: pulling in the query-builder module would drag Drizzle and the
 * schema into a browser bundle.
 *
 * Keep this and `derivedPageId()` in step. They are one rule with two
 * renderings, and `unified-message-scope`'s own test asserts they agree.
 */

/** The conversation columns the derivation reads — a subset of a `conversations` row. */
export interface ConversationPageSubject {
  /** `'global' | 'page' | 'drive' | 'client'`. */
  type: string;
  /** The PAGE for `type='page'`; a DRIVE for `type='client'`; null for global. */
  contextId: string | null;
  /** The PAGE for `type='client'`, which needs a column of its own because its `contextId` is a drive. */
  agentPageId?: string | null;
}

/**
 * The page this conversation belongs to, or `null` when it names none.
 *
 * Two conversation kinds name a page and each names it in its own column:
 * `type='page'` → `contextId`, `type='client'` → `agentPageId`. `'global'` and
 * `'drive'` name no page, and that NULL is load-bearing — it is what the
 * page-scoped edit/delete routes 404 on, so a page route can never become a
 * second door onto a global-assistant message.
 */
export function conversationPageId(
  conversation: ConversationPageSubject | null | undefined,
): string | null {
  if (!conversation) return null;
  if (conversation.type === 'page') return conversation.contextId ?? null;
  if (conversation.type === 'client') return conversation.agentPageId ?? null;
  return null;
}

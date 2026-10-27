/**
 * MAY THIS CALLER READ/WRITE THIS CONVERSATION, ADDRESSED AT THIS PAGE?
 *
 * One pure decision, shared by every page-agent surface that accepts a
 * caller-supplied `conversationId`. It was inline in `page-chat-turn.ts` and
 * nowhere else, which is how the consult route came to read other users'
 * transcripts on a shared agent page: `canPrincipalViewPage` answers "may you
 * use this AGENT", never "is this CONVERSATION yours", and the page-scoped
 * readers (`unifiedPageScope`) carry no user predicate at all.
 *
 * Two independent questions, both of which must pass:
 *
 *  1. **Is it yours to read?** Owned by the caller, or explicitly shared.
 *  2. **Does it belong to THIS page?** A function of the conversation's
 *     `type`, never of `contextId` alone — that column means a different thing
 *     per type, and reading it type-blind is what made the original check
 *     unsound. A `type='global'` row always has `contextId IS NULL` (enforced
 *     by `conversations_global_context_null_chk`, migration 0251), so a
 *     null-tolerant test said every global conversation belongs to every page.
 *     `type='client'` had the mirror hole: its `contextId` is a DRIVE.
 *
 * The rule is the one every page-scoped READER already uses
 * (`lib/repositories/unified-message-scope.ts`): `type='page'` names its page
 * in `contextId`, `type='client'` in `agentPageId`, and nothing else names a
 * page at all. Gating access on the same rule that scopes reads is the point.
 *
 * The single deliberate widening is a legacy tolerance:
 * `conversations_page_context_present_chk` shipped NOT VALID, so `type='page'`
 * rows with a null `contextId` were grandfathered and their owners must not be
 * locked out of their own history. Scoped to `type='page'` AND to the OWNER —
 * without the owner scope a legacy null-context row with `isShared=true` would
 * be reachable by any co-member from any page they can see.
 */

export interface PageConversationFacts {
  userId: string;
  type: string;
  contextId: string | null;
  agentPageId: string | null;
  isShared: boolean | null;
  /**
   * Optional on purpose. The refusal below tests `=== false`, not falsiness, so
   * a row that simply does not carry the column — a partial projection, a
   * legacy row — is treated as live rather than as history-deleted. Only an
   * EXPLICIT deactivation refuses. Reading this as `!isActive` would turn every
   * such row into a 404.
   */
  isActive?: boolean | null;
}

export type PageConversationAccess =
  | { allowed: true }
  | {
      allowed: false;
      /** `history_deleted` is the caller's OWN row — distinguishable on purpose. */
      reason: 'history_deleted' | 'not_yours' | 'wrong_page';
      /** For the refusal log. A refusal is undiagnosable without the type. */
      detail: { ownsIt: boolean; isSharedConversation: boolean; belongsToThisPage: boolean; conversationType: string };
    };

export function authorizePageConversation(
  conversation: PageConversationFacts,
  { userId, pageId }: { userId: string; pageId: string },
): PageConversationAccess {
  const ownsIt = conversation.userId === userId;
  const isSharedConversation = conversation.isShared === true;
  const belongsToThisPage =
    conversation.type === 'page'
      ? conversation.contextId === pageId || (conversation.contextId === null && ownsIt)
      : conversation.type === 'client'
        ? conversation.agentPageId === pageId
        : false;

  const detail = { ownsIt, isSharedConversation, belongsToThisPage, conversationType: conversation.type };

  // History-delete deactivates the CANONICAL row, not just its messages, and a
  // conversation can still be open in another pane or browser tab. Checked
  // first, and only for a row the caller could otherwise reach — a foreign row
  // must not report `history_deleted`, which would be an existence oracle.
  if (!ownsIt && !isSharedConversation) return { allowed: false, reason: 'not_yours', detail };
  // `=== false`, never `!isActive` — see the field's doc. Only an explicitly
  // deactivated row is history-deleted.
  if (conversation.isActive === false) return { allowed: false, reason: 'history_deleted', detail };
  if (!belongsToThisPage) return { allowed: false, reason: 'wrong_page', detail };
  return { allowed: true };
}

/**
 * Pure state machine for conversation identity, shared across chat surfaces.
 *
 * Conversation identity (`conversationId`) was previously tracked independently
 * in useConversations.ts, usePageAgentDashboardStore.ts, GlobalChatContext.tsx,
 * and AiChatView.tsx local state, each written asynchronously after a network
 * round trip. That duplication let a message send race an in-flight
 * create/switch: the send closed over whatever id was in state at the moment
 * it fired, which could be stale by the time the request landed.
 *
 * This machine only has one state that reflects genuine async uncertainty
 * (`resolving`, e.g. "which conversation does this page already have?"). A new
 * or selected conversation id is knowable synchronously (client-generated cuid2,
 * or already present in a history list), so IDENTITY_SET goes straight to
 * `ready` from any state — no transient blocking window to race against.
 *
 * `resolving`'s own async result (RESOLVED/RESOLVE_FAILED) is dropped if the
 * state has since moved on via IDENTITY_SET — a stale resolve must never
 * clobber an identity the user has already set more recently.
 */

export type ConversationIdentityState =
  | { status: 'idle' }
  | { status: 'resolving' }
  | { status: 'ready'; conversationId: string }
  | { status: 'error'; message: string };

export type ConversationIdentityAction =
  | { type: 'RESOLVE_STARTED' }
  | { type: 'RESOLVED'; conversationId: string }
  | { type: 'RESOLVE_FAILED'; message: string }
  | { type: 'IDENTITY_SET'; conversationId: string }
  | { type: 'RETRY' };

export function conversationIdentityReducer(
  state: ConversationIdentityState,
  action: ConversationIdentityAction
): ConversationIdentityState {
  switch (action.type) {
    case 'RESOLVE_STARTED':
      return state.status === 'idle' ? { status: 'resolving' } : state;

    case 'RESOLVED':
      return state.status === 'resolving'
        ? { status: 'ready', conversationId: action.conversationId }
        : state;

    case 'RESOLVE_FAILED':
      return state.status === 'resolving'
        ? { status: 'error', message: action.message }
        : state;

    case 'IDENTITY_SET':
      return { status: 'ready', conversationId: action.conversationId };

    case 'RETRY':
      return state.status === 'error' ? { status: 'resolving' } : state;

    default:
      return state;
  }
}

export function canSend(
  state: ConversationIdentityState
): state is { status: 'ready'; conversationId: string } {
  return state.status === 'ready';
}

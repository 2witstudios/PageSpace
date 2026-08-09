/**
 * Socket event names for the conversation content + directory planes — the ONE
 * definition, in the spirit of the room grammar next door (`rooms.ts`).
 *
 * These names are a contract between two files that never see each other's
 * types: the emitter (`apps/web/src/lib/websocket/conversation-events.ts`) and
 * the listeners (`useConversationSubscription.ts`,
 * `session-directory-listener.ts`). The payload TYPES were already shared, but
 * the names were bare string literals restated on both sides, so renaming one
 * produced no type error anywhere — just an emitter shouting into a room where
 * nobody was listening for that name, and a listener waiting for a name nobody
 * sends. Silent, and invisible to every test that mocks the transport.
 *
 * Pure strings, no imports: `'use client'` modules import this, and it must
 * never drag the emitter's HMAC signing or `Buffer` use into a browser bundle.
 *
 * Two planes, deliberately distinct:
 *  - CONTENT goes to `conv:<id>` and describes messages. Membership is
 *    authorization (join_conversation admits the owner, or a shared page's
 *    members).
 *  - DIRECTORY goes to the owner's own socket room and the page room, and
 *    carries METADATA ONLY — never message content. See the audience invariant
 *    suite for why that separation is load-bearing.
 *
 * There is deliberately no `ConversationEventName` union over both planes. One
 * existed, unused, and knip found it (review finding): a type that spans the
 * two planes is a type whose values cannot be routed without re-deciding which
 * plane they belong to, which is the distinction this module exists to make
 * unavoidable. Consumers take the narrower union they actually mean.
 */

/** Content plane: what happened to the messages inside one conversation. */
export const CONVERSATION_CONTENT_EVENTS = {
  messageCreated: 'conversation:message_created',
  messageUpdated: 'conversation:message_updated',
  messageDeleted: 'conversation:message_deleted',
  undoApplied: 'conversation:undo_applied',
} as const;

/** Directory plane: what happened to the conversation ROW, for listings. */
export const CONVERSATION_DIRECTORY_EVENTS = {
  created: 'conversation:created',
  updated: 'conversation:updated',
  closed: 'conversation:closed',
  reopened: 'conversation:reopened',
  deleted: 'conversation:deleted',
} as const;

export const CONVERSATION_EVENTS = {
  ...CONVERSATION_CONTENT_EVENTS,
  ...CONVERSATION_DIRECTORY_EVENTS,
} as const;

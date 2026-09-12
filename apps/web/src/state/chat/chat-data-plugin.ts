import { Database } from '@adobe/data/ecs';
import type { UIMessage } from 'ai';
import type { ConversationLoadStatus, PendingMutation } from '@/stores/conversationMessages/seedEmpty';
import type { PendingStream } from '@/stores/pendingStreams/applyAddStream';

type UIMessagePart = UIMessage['parts'][number];

/**
 * SPIKE (@adobe/data adoption evidence). Data-only half of the chat-state
 * plugin: components, archetypes and indexes, with NO transactions.
 *
 * It is split from `chat-state-plugin.ts` so the column read/write helpers can
 * be typed against `Database.Plugin.ToStore<typeof chatDataPlugin>` without a
 * circular type reference (the behavior plugin's transactions consume those
 * helpers, so the helpers cannot depend on the behavior plugin's own type).
 *
 * Modeling notes (per aidd-ecs data-modeling):
 * - one entity per conversation, one entity per live stream — the two keyed
 *   collections that `useConversationMessagesStore.byConversationId` and
 *   `usePendingStreamsStore.streams` hold as plain Record/Map today;
 * - opaque JS payloads (`UIMessage[]`, part arrays, the recorded pending
 *   mutation queue) are `mutable: true` components: they are stored by
 *   reference and replaced wholesale by the pure transition functions, so the
 *   library must not deep-freeze them into `DeepReadonly`;
 * - `streamsByPageId` / `conversationById` are real ECS indexes, which is what
 *   removes the full-collection scan the epic filed as a `D` finding against
 *   `usePendingStreamsStore.getRemotePageStreams`.
 */
export const chatDataPlugin = Database.Plugin.create({
  components: {
    conversationId: { type: 'string' },
    messages: { default: [] as UIMessage[], mutable: true },
    optimisticSends: { default: [] as UIMessage[], mutable: true },
    loadGeneration: { type: 'integer' },
    pendingMutationsSinceLoad: { default: [] as PendingMutation[], mutable: true },
    loadStatus: { default: 'idle' as ConversationLoadStatus, mutable: true },
    olderCursor: { default: null as string | null, mutable: true },
    hasMoreOlder: { type: 'boolean' },
    isLoadingOlder: { type: 'boolean' },

    streamMessageId: { type: 'string' },
    streamPageId: { type: 'string' },
    streamConversationId: { type: 'string' },
    streamTriggeredBy: { default: null as unknown as PendingStream['triggeredBy'], mutable: true },
    streamParts: { default: [] as UIMessagePart[], mutable: true },
    streamIsOwn: { type: 'boolean' },
    /** `null` encodes "absent" — the facade projects it back to an omitted key. */
    streamStartedAt: { default: null as string | null, mutable: true },
    /** `null` encodes "no replace-semantics write yet" (`PendingStream.lastSeq` undefined). */
    streamLastSeq: { default: null as number | null, mutable: true },
  },
  archetypes: {
    Conversation: [
      'conversationId',
      'messages',
      'optimisticSends',
      'loadGeneration',
      'pendingMutationsSinceLoad',
      'loadStatus',
      'olderCursor',
      'hasMoreOlder',
      'isLoadingOlder',
    ],
    PendingStream: [
      'streamMessageId',
      'streamPageId',
      'streamConversationId',
      'streamTriggeredBy',
      'streamParts',
      'streamIsOwn',
      'streamStartedAt',
      'streamLastSeq',
    ],
  },
  indexes: {
    conversationById: { key: 'conversationId', unique: true, archetype: 'Conversation' },
    streamByMessageId: { key: 'streamMessageId', unique: true, archetype: 'PendingStream' },
    streamsByPageId: { key: 'streamPageId', archetype: 'PendingStream' },
  },
});

export type ChatDataDatabase = Database.Plugin.ToDatabase<typeof chatDataPlugin>;
/**
 * The read-only projection every projection helper takes. `Database.Read` is
 * what a `db.derive` callback receives, and the full `Database` (what `actions`
 * receive) is a superset of it — so one helper serves computed, actions and the
 * facade without a cast.
 */
export type ChatDataRead = Database.Read<ChatDataDatabase>;
/**
 * The store as seen inside a transaction body. Unlike `Plugin.ToStore`, this
 * alias carries the declared `indexes`, which the transitions rely on for
 * O(1) entity lookup.
 */
export type ChatDataTransaction = Database.Plugin.ToTransactionContext<typeof chatDataPlugin>;

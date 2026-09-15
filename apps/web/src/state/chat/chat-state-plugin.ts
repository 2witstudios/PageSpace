import { Database, applyOperations } from '@adobe/data/ecs';
import type { UIMessage } from 'ai';
import { applyStartLoad } from '@/stores/conversationMessages/applyStartLoad';
import { applyLoad } from '@/stores/conversationMessages/applyLoad';
import { applyFailLoad } from '@/stores/conversationMessages/applyFailLoad';
import { applyOptimisticSend } from '@/stores/conversationMessages/applyOptimisticSend';
import { applyOptimisticSendFailure } from '@/stores/conversationMessages/applyOptimisticSendFailure';
import { applyOlderPage } from '@/stores/conversationMessages/applyOlderPage';
import { applyConversationEdit } from '@/stores/conversationMessages/applyConversationEdit';
import { applyConversationDelete } from '@/stores/conversationMessages/applyConversationDelete';
import { applyConversationAskUserAnswer } from '@/stores/conversationMessages/applyConversationAskUserAnswer';
import { applyRemoteUserMessage } from '@/stores/conversationMessages/applyRemoteUserMessage';
import { applyConfirmedMessage } from '@/stores/conversationMessages/applyConfirmedMessage';
import { promoteOptimisticSends } from '@/stores/conversationMessages/promoteOptimisticSends';
import { replayPendingMutations } from '@/stores/conversationMessages/replayPendingMutations';
import { seedEmpty, type ConversationCacheEntry } from '@/stores/conversationMessages/seedEmpty';
import { appendPart as appendPartPure } from '@/lib/ai/streams/appendPart';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import {
  revertAskUserAnswer,
  type AskUserAnswerPayload,
  type AskUserAnswerRevertPayload,
} from '@/lib/ai/streams/applyAskUserAnswer';
import type { PendingStream } from '@/stores/pendingStreams/applyAddStream';
import { chatDataPlugin } from './chat-data-plugin';
import { readConversationEntry, transitionConversation } from './conversationEntry';
import { readPageStreams, readPendingStream } from './pendingStreamRow';

type UIMessagePart = UIMessage['parts'][number];

/**
 * SPIKE (@adobe/data adoption evidence). Behavior half of the chat-state
 * plugin: the two chat stores of E1 PR3 expressed as `transactions` (the
 * `applyX` pure transitions, unchanged), `computed` (the render selectors) and
 * `actions` (the void helpers + the value-returning glue the effects need).
 *
 * Two porting patterns show up, and they behave differently:
 *
 * 1. KEYED transitions (`useConversationMessagesStore`) port 1:1. Each
 *    `applyX(byConversationId, event)` runs verbatim inside
 *    `transitionConversation`, against a one-key projection of the conversation
 *    entity. Zero changes to the transition functions.
 * 2. WHOLE-COLLECTION transitions (`usePendingStreamsStore`) do not: their
 *    input is the entire `Map`, which is exactly the shape ECS replaces. These
 *    are rewritten against the store — and the rewrite is where the index win
 *    lands (see `pendingStreamRow.readPageStreams`). Their *sub*-level pure
 *    helper (`appendPart`) is still reused untouched.
 *
 * Undo policy: NOTHING here is undoable by default. Only `aiApplyEdit` sets
 * `t.undoable`, so a user's Ctrl-Z undoes the AI's edit and never a send, a
 * stream frame, or a load — which is the answer to the epic's "≤1 transaction
 * per action, don't corrupt the undo stack" constraint.
 */
const chatBehaviorPlugin = Database.Plugin.create({
  extends: chatDataPlugin,
  transactions: {
    /** Required by `createUndoRedoService` — the replay entry point for undo/redo ops. */
    applyOperations: (t, operations: Parameters<typeof applyOperations>[1]) => {
      applyOperations(t, operations);
    },

    startLoad: (t, conversationId: string) => {
      transitionConversation(t, conversationId, (by) => applyStartLoad(by, conversationId).byConversationId);
    },
    applyLoad: (
      t,
      event: {
        conversationId: string;
        generation: number;
        messages: UIMessage[];
        pagination?: { hasMore: boolean; nextCursor: string | null };
      },
    ) => {
      transitionConversation(t, event.conversationId, (by) => applyLoad(by, event));
    },
    failLoad: (t, event: { conversationId: string; generation: number }) => {
      transitionConversation(t, event.conversationId, (by) => applyFailLoad(by, event));
    },
    startLoadingOlder: (t, conversationId: string) => {
      transitionConversation(t, conversationId, (by) => {
        const existing = by[conversationId];
        if (!existing) return by;
        return { ...by, [conversationId]: { ...existing, isLoadingOlder: true } };
      });
    },
    applyOlderPage: (
      t,
      event: {
        conversationId: string;
        generation: number;
        messages: UIMessage[];
        hasMoreOlder: boolean;
        nextCursor: string | null;
      },
    ) => {
      transitionConversation(t, event.conversationId, (by) => applyOlderPage(by, event));
    },
    failLoadingOlder: (t, event: { conversationId: string; generation: number }) => {
      transitionConversation(t, event.conversationId, (by) => {
        const existing = by[event.conversationId];
        if (!existing || existing.loadGeneration !== event.generation) return by;
        return { ...by, [event.conversationId]: { ...existing, isLoadingOlder: false } };
      });
    },
    addOptimisticSend: (t, event: { conversationId: string; message: UIMessage }) => {
      transitionConversation(t, event.conversationId, (by) => applyOptimisticSend(by, event));
    },
    removeOptimisticSendOnFailure: (t, event: { conversationId: string; messageId: string }) => {
      transitionConversation(t, event.conversationId, (by) => applyOptimisticSendFailure(by, event));
    },
    applyEdit: (t, event: { conversationId: string; payload: MessageEditPayload }) => {
      transitionConversation(t, event.conversationId, (by) => applyConversationEdit(by, event));
    },
    applyDelete: (t, event: { conversationId: string; messageId: string }) => {
      transitionConversation(t, event.conversationId, (by) => applyConversationDelete(by, event));
    },
    applyAskUserAnswer: (t, event: { conversationId: string; payload: AskUserAnswerPayload }) => {
      transitionConversation(t, event.conversationId, (by) => applyConversationAskUserAnswer(by, event));
    },
    revertAskUserAnswer: (t, event: { conversationId: string; payload: AskUserAnswerRevertPayload }) => {
      transitionConversation(t, event.conversationId, (by) => {
        const existing = by[event.conversationId];
        if (!existing) return by;
        return {
          ...by,
          [event.conversationId]: {
            ...existing,
            messages: revertAskUserAnswer(existing.messages, event.payload),
          },
        };
      });
    },
    applyRemoteUserMessage: (t, event: { conversationId: string; message: UIMessage }) => {
      transitionConversation(t, event.conversationId, (by) => applyRemoteUserMessage(by, event));
    },
    applyConfirmedMessage: (t, event: { conversationId: string; message: UIMessage }) => {
      transitionConversation(t, event.conversationId, (by) => applyConfirmedMessage(by, event));
    },
    promoteOptimisticSends: (t, conversationId: string) => {
      transitionConversation(t, conversationId, (by) => promoteOptimisticSends(by, conversationId));
    },
    /**
     * The cross-store atomicity the epic hand-managed: `startLoad` + `applyLoad`
     * composed inside ONE transaction, so no observer can ever see the
     * intermediate 'loading' state this composition passes through.
     */
    applyServerSnapshot: (
      t,
      event: { conversationId: string; generationToken: number; messages: UIMessage[] },
    ) => {
      transitionConversation(t, event.conversationId, (by) => {
        const currentGeneration = by[event.conversationId]?.loadGeneration ?? 0;
        if (currentGeneration !== event.generationToken) return by;
        const pendingSinceFetch = by[event.conversationId]?.pendingMutationsSinceLoad ?? [];
        const { byConversationId, generation } = applyStartLoad(by, event.conversationId);
        return applyLoad(byConversationId, {
          conversationId: event.conversationId,
          generation,
          messages: replayPendingMutations(event.messages, pendingSinceFetch),
        });
      });
    },
    seedConversation: (t, conversationId: string) => {
      transitionConversation(t, conversationId, (by) => {
        const { byConversationId, generation } = applyStartLoad(by, conversationId);
        return applyLoad(byConversationId, { conversationId, generation, messages: [] });
      });
    },

    /**
     * The AI-actions prototype's write half: an edit applied by an AI tool call,
     * marked undoable so the built-in undo/redo stack can revert exactly it.
     * `coalesce: false` keeps consecutive AI edits as separate undo steps.
     */
    aiApplyEdit: (t, event: { conversationId: string; payload: MessageEditPayload }) => {
      t.undoable = { coalesce: false };
      transitionConversation(t, event.conversationId, (by) => applyConversationEdit(by, event));
    },

    addStream: (t, stream: Omit<PendingStream, 'parts' | 'lastSeq'> & { parts?: UIMessagePart[] }) => {
      if (t.indexes.streamByMessageId.get({ streamMessageId: stream.messageId }) !== null) return;
      t.archetypes.PendingStream.insert({
        streamMessageId: stream.messageId,
        streamPageId: stream.pageId,
        streamConversationId: stream.conversationId,
        streamTriggeredBy: stream.triggeredBy,
        streamParts: stream.parts ?? [],
        streamIsOwn: stream.isOwn,
        streamStartedAt: stream.startedAt ?? null,
        streamLastSeq: null,
      });
    },
    appendPart: (t, event: { messageId: string; part: UIMessagePart }) => {
      const entity = t.indexes.streamByMessageId.get({ streamMessageId: event.messageId });
      if (entity === null) return;
      const parts = t.get(entity, 'streamParts') ?? [];
      const next = appendPartPure(parts, event.part);
      if (next === parts) return;
      t.update(entity, { streamParts: next });
    },
    setStreamParts: (t, event: { messageId: string; parts: UIMessagePart[]; seq: number }) => {
      const entity = t.indexes.streamByMessageId.get({ streamMessageId: event.messageId });
      if (entity === null) return;
      if (event.seq <= (t.get(entity, 'streamLastSeq') ?? -1)) return;
      t.update(entity, { streamParts: event.parts, streamLastSeq: event.seq });
    },
    removeStream: (t, messageId: string) => {
      const entity = t.indexes.streamByMessageId.get({ streamMessageId: messageId });
      if (entity === null) return;
      t.delete(entity);
    },
    clearPageStreams: (t, pageId: string) => {
      for (const entity of [...t.indexes.streamsByPageId.find({ streamPageId: pageId })]) {
        t.delete(entity);
      }
    },

    /** Test/teardown glue only — the `setState({ byConversationId: {} })` equivalent. */
    resetChatState: (t) => {
      t.reset();
    },
  },
  actions: {
    /**
     * Bumps the load generation and returns it, matching the zustand action's
     * contract (callers pass it into the matching `applyLoad`/`failLoad`).
     *
     * Deliberately NOT a transaction: transactions may only return `void |
     * Entity`. The generation is derived from a read taken before the single
     * transaction, so it is still deterministic and still one transaction.
     */
    startLoad: (db, conversationId: string): number => {
      const entity = db.indexes.conversationById.get({ conversationId });
      const next = (entity === null ? 0 : db.get(entity, 'loadGeneration') ?? 0) + 1;
      db.transactions.startLoad(conversationId);
      return next;
    },
    isLoadCurrent: (db, event: { conversationId: string; generation: number }): boolean => {
      const entity = db.indexes.conversationById.get({ conversationId: event.conversationId });
      return entity !== null && db.get(entity, 'loadGeneration') === event.generation;
    },
    beginServerSnapshot: (db, conversationId: string): number => {
      const entity = db.indexes.conversationById.get({ conversationId });
      return entity === null ? 0 : db.get(entity, 'loadGeneration') ?? 0;
    },
    getEntry: (db, conversationId: string): ConversationCacheEntry => {
      const entity = db.indexes.conversationById.get({ conversationId });
      return entity === null ? seedEmpty() : readConversationEntry(db, entity);
    },
    getRemotePageStreams: (db, pageId: string): PendingStream[] => readPageStreams(db, pageId),
    getOwnStreams: (db, pageId: string): PendingStream[] =>
      readPageStreams(db, pageId).filter((stream) => stream.isOwn),
    getStream: (db, messageId: string): PendingStream | null => {
      const entity = db.indexes.streamByMessageId.get({ streamMessageId: messageId });
      return entity === null ? null : readPendingStream(db, entity);
    },
    /**
     * AI-actions prototype: an AI tool result becomes ONE action dispatching ONE
     * undoable transaction, so the user's undo reverts the whole applied edit
     * atomically. Returns nothing — unidirectional flow (aidd-service).
     */
    aiApplyEdit: (db, event: { conversationId: string; payload: MessageEditPayload }): void => {
      db.transactions.aiApplyEdit(event);
    },
  },
});

/**
 * Final composition: `computed` MUST live in a plugin separate from `actions`.
 *
 * SPIKE FINDING (@adobe/data 0.9.83): declaring `computed` and `actions` in the
 * SAME `Database.Plugin.create` call silently collapses the inferred action
 * declarations to `{}` — `db.actions.X` becomes a compile error — because the
 * `computed` factories' constraint type references the action generic and
 * poisons its inference. Splitting the two across an `extends` boundary, as
 * here, keeps both fully typed with no `any` and no cast. Non-obvious, and it
 * dictates plugin layout for every adopter, so it is written up on the spike
 * page.
 */
export const chatStatePlugin = Database.Plugin.create({
  extends: chatBehaviorPlugin,
  computed: {
    /** Render source for a conversation — the `computed` form of `getEntry`. */
    conversationEntry: (db) => (conversationId: string) =>
      db.derive((read) => {
        const entity = read.indexes.conversationById.get({ conversationId });
        return entity === null ? seedEmpty() : readConversationEntry(read, entity);
      }),
    /** Every live stream on a page — the `computed` form of `getRemotePageStreams`. */
    pageStreams: (db) => (pageId: string) =>
      db.derive((read) => readPageStreams(read, pageId)),
    /** Own-tab live streams on a page — the `computed` form of `getOwnStreams`. */
    ownPageStreams: (db) => (pageId: string) =>
      db.derive((read) => readPageStreams(read, pageId).filter((stream) => stream.isOwn)),
  },
});

export type ChatStateDatabase = Database.Plugin.ToDatabase<typeof chatStatePlugin>;

/**
 * What was said, written into the conversation as ordinary messages.
 *
 * THIS IS THE THESIS MADE LITERAL. Voice is a second transport onto a
 * conversation PageSpace already has: you speak into a thread that existed
 * before the call and still exists after you hang up. Audio is ephemeral; the
 * transcript is the artifact of record. So a spoken turn does not become a
 * "voice message" in a "voice history" — it becomes a `messages` row, in the
 * same table, in the same conversation, that the same readers read.
 *
 * WHY THERE IS NO NEW CLIENT WIRING. Going through `messageRepository` means
 * going through the write that bumps `conversations.rev` IN-TRANSACTION and
 * then emits the `conversation:*` events. The sidebar, GlobalAssistantView and
 * page-agent chat already subscribe to those, so a spoken sentence appears in
 * an open thread live, for free — and it does so because this code is NOT a
 * second writer, not because anything was taught about voice. A direct INSERT
 * here would have been shorter and would have silently cost all of that.
 *
 * PERMISSIONS come from `canAccessConversation` — the same predicate the
 * realtime `join_conversation` handler and the stream-subscription routes use.
 * It resolves to owner-only for a global conversation (a shared global thread
 * has no page to share through) and owner-or-(shared AND page access) for a
 * page one, which is the write rule the page-agent messages route already
 * applies. One predicate, not a voice-shaped variant of it.
 *
 * Every dependency arrives as an argument, so the whole decision tree below is
 * exercisable without a database.
 */

import { MESSAGE_SOURCE_VOICE } from '@pagespace/db/schema/conversations';

/** The conversation facts this module needs. A `conversations` row satisfies it. */
export type TranscriptConversation = {
  readonly id: string;
  readonly userId: string;
  readonly isShared: boolean;
  readonly type: string;
  readonly contextId: string | null;
  readonly isActive: boolean;
};

export type TranscriptRequest = {
  readonly callId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
};

export type TranscriptWriteResult = {
  readonly saved: boolean;
  readonly messageId: string | null;
  readonly rev: number;
  /** Why nothing was written. Absent on success. */
  readonly skipped?:
    | 'no_access'
    | 'history_deleted'
    | 'unsupported_conversation_type'
    | 'blank'
    | 'create_failed';
};

type SaveArgs = {
  readonly messageId: string;
  readonly conversationId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly source: string;
};

export type TranscriptPersistenceDeps = {
  readonly loadConversation: (
    conversationId: string,
  ) => Promise<TranscriptConversation | undefined>;
  /** Lazy first-message creation, exactly as the typed path does it. */
  readonly createConversation: (
    userId: string,
    conversationId: string,
  ) => Promise<TranscriptConversation | undefined>;
  readonly canAccess: (
    userId: string,
    conversation: TranscriptConversation,
  ) => Promise<boolean>;
  readonly saveGlobalMessage: (
    args: SaveArgs & { readonly userId: string },
  ) => Promise<{ saved: boolean; rev: number }>;
  readonly savePageMessage: (
    args: SaveArgs & {
      readonly pageId: string;
      readonly userId: string | null;
      readonly sourceAgentId: string | null;
    },
  ) => Promise<{ saved: boolean; rev: number }>;
  readonly newMessageId: () => string;
  readonly logger: {
    readonly warn: (message: string, meta?: Record<string, unknown>) => void;
  };
};

const NOTHING: TranscriptWriteResult = { saved: false, messageId: null, rev: 0 };

/**
 * Persist one spoken turn.
 *
 * The conversation may not exist yet: a call started from a fresh thread binds
 * to a client-minted cuid whose row is created by its first message, exactly
 * as typing into that thread would. That path yields a GLOBAL conversation,
 * because a client-minted id with no row is by construction not a page thread.
 *
 * A conversation that DOES exist decides its own shape:
 *   - `global` — the row carries the owner's `userId` on both sides, matching
 *     every other global write (the global assistant is not an agent page, so
 *     there is no agent id to attribute an assistant row to);
 *   - `page` — the assistant row is agent-authored: `userId: null` with
 *     `sourceAgentId` naming the agent page, which is the attribution rule the
 *     `messages` table documents;
 *   - anything else (`drive`, `client`) is refused rather than guessed at. A
 *     `client` thread is an API-managed conversation whose page is claimed
 *     write-once by its first completion; writing a spoken turn into one would
 *     be this module inventing a binding nobody asked for.
 */
export const persistVoiceTranscript = async (
  deps: TranscriptPersistenceDeps,
  request: TranscriptRequest,
): Promise<TranscriptWriteResult> => {
  const content = request.text.trim();
  if (content.length === 0) {
    // A blank transcript is a real event — the model heard breath, or the
    // transcriber returned nothing — and an empty message row is worse than
    // no row: it renders as a turn that said nothing.
    return { ...NOTHING, skipped: 'blank' };
  }

  const existing = await deps.loadConversation(request.conversationId);

  if (!existing) {
    const created = await deps.createConversation(request.userId, request.conversationId);
    if (!created) {
      deps.logger.warn('Voice transcript could not resolve or create its conversation', {
        callId: request.callId,
        userId: request.userId,
        conversationId: request.conversationId,
      });
      return { ...NOTHING, skipped: 'create_failed' };
    }
    return writeGlobal(deps, request, created, content);
  }

  if (!existing.isActive) {
    // History-deleted mid-call. Writing under it would put the turn somewhere
    // no listing can reach — the same reason the typed path's beforeSave hook
    // re-checks this inside its transaction.
    deps.logger.warn('Voice transcript dropped: conversation was deleted from history', {
      callId: request.callId,
      conversationId: request.conversationId,
    });
    return { ...NOTHING, skipped: 'history_deleted' };
  }

  if (!(await deps.canAccess(request.userId, existing))) {
    deps.logger.warn('Voice transcript refused: caller cannot access the conversation', {
      callId: request.callId,
      userId: request.userId,
      conversationId: request.conversationId,
    });
    return { ...NOTHING, skipped: 'no_access' };
  }

  if (existing.type === 'global') {
    return writeGlobal(deps, request, existing, content);
  }

  if (existing.type === 'page' && existing.contextId) {
    const messageId = deps.newMessageId();
    const result = await deps.savePageMessage({
      messageId,
      conversationId: request.conversationId,
      role: request.role,
      content,
      source: MESSAGE_SOURCE_VOICE,
      pageId: existing.contextId,
      // The attribution rule: a human author, or NULL for an agent-authored row.
      userId: request.role === 'user' ? request.userId : null,
      sourceAgentId: request.role === 'assistant' ? existing.contextId : null,
    });
    return { saved: result.saved, messageId: result.saved ? messageId : null, rev: result.rev };
  }

  deps.logger.warn('Voice transcript dropped: unsupported conversation type', {
    callId: request.callId,
    conversationId: request.conversationId,
    type: existing.type,
  });
  return { ...NOTHING, skipped: 'unsupported_conversation_type' };
};

const writeGlobal = async (
  deps: TranscriptPersistenceDeps,
  request: TranscriptRequest,
  conversation: TranscriptConversation,
  content: string,
): Promise<TranscriptWriteResult> => {
  const messageId = deps.newMessageId();
  const result = await deps.saveGlobalMessage({
    messageId,
    conversationId: request.conversationId,
    role: request.role,
    content,
    source: MESSAGE_SOURCE_VOICE,
    // The conversation's OWNER, not the speaker: they are the same person on
    // every path that reaches here (a global thread is owner-only), and taking
    // it off the row keeps this consistent with every other global write.
    userId: conversation.userId,
  });
  return { saved: result.saved, messageId: result.saved ? messageId : null, rev: result.rev };
};

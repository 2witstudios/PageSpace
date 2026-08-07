/**
 * THE GENERATION START — takeover, stream lifecycle and the `'streaming'`
 * placeholder, under one per-conversation advisory lock. Shared outright by
 * both chat strategies (epic "Agent-Session Single Source of Truth", Phase 5).
 *
 * This is the one stretch of the two routes that was duplicated rather than
 * merely similar: the same critical section, the same three operations in the
 * same order, the same "`run` must never throw while the lock is held" rule,
 * the same best-effort placeholder — differing only in which channel the
 * takeover names and which repository method inserts the placeholder. Keeping
 * two copies of a lock protocol is how the copies drift, and a drift here is
 * double generation and double billing, so this one is genuinely one function
 * with a two-branch tail rather than two functions that happen to agree.
 *
 * Nothing about the protocol changed in the move. The comments below are the
 * originals, because the reasoning they record is still the reasoning.
 */

import { createStreamLifecycle, type StreamLifecycleHandle } from '@/lib/ai/core/stream-lifecycle';
import { takeOverConversationStreams } from '@/lib/ai/core/stream-takeover';
import { startGenerationExclusive } from '@/lib/ai/core/start-generation-exclusive';
import { messageRepository } from '@/lib/repositories/message-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Which strategy is starting the generation — the ONLY thing that differs
 * between the two callers, expressed as data instead of as a duplicated block.
 *
 * `page` inserts through `insertPageStreamingPlaceholder` (which derives the
 * row's page from its conversation); `global` through
 * `insertGlobalStreamingPlaceholder` (which stamps the owning user). Both go
 * to the same unified `messages` table and both carry the same in-transaction
 * `isActive` re-check.
 */
export type ChatGenerationScope =
  | { kind: 'page'; pageId: string }
  | { kind: 'global'; userId: string };

export interface StartChatGenerationArgs {
  conversationId: string;
  /** The realtime channel the takeover and lifecycle name (page id, or the user's global channel). */
  channelId: string;
  messageId: string;
  userId: string;
  displayName: string;
  browserSessionId: string;
  streamId: string;
  isShared: boolean;
  scope: ChatGenerationScope;
}

/**
 * Per-conversation in-flight guard + lifecycle + placeholder.
 *
 * A second send takes the conversation OVER — aborts whatever is live,
 * reconciles its row — rather than being rejected, because a row whose terminal
 * write never landed (crashed process; the write is fire-and-forget) would
 * otherwise lock the user out of their own chat. See stream-liveness.ts.
 *
 * BEST-EFFORT, not an invariant — named honestly. `startGenerationExclusive`
 * closes the check-then-act race (the SELECT inside
 * `takeOverConversationStreams` and the INSERT inside `createStreamLifecycle`
 * are not atomic on their own) by holding a per-conversation Postgres advisory
 * lock across both. On lock_busy it retries briefly, then proceeds UNLOCKED
 * rather than blocking the send — availability wins over serialization, so a
 * rare contention/pool-exhaustion case can still double-generate. See
 * start-generation-exclusive.ts and the PR 4 board page.
 */
export async function startChatGeneration(
  args: StartChatGenerationArgs,
): Promise<StreamLifecycleHandle> {
  const log = args.scope.kind === 'page' ? loggers.ai : loggers.api;
  const label =
    args.scope.kind === 'page' ? 'AI Chat API' : 'Global AI messages API';

  const generation = await startGenerationExclusive({
    conversationId: args.conversationId,
    run: async () => {
      await takeOverConversationStreams({
        conversationId: args.conversationId,
        channelId: args.channelId,
      });

      const streamLifecycle = await createStreamLifecycle({
        messageId: args.messageId,
        channelId: args.channelId,
        conversationId: args.conversationId,
        userId: args.userId,
        displayName: args.displayName,
        browserSessionId: args.browserSessionId,
        streamId: args.streamId,
        isShared: args.isShared,
      });

      // Assistant message row at stream start (Server Stream Durability epic, PR 2): a
      // 'streaming' placeholder so history can show in-flight entries and pre-checkpoint
      // process death doesn't silently lose the reply. Same critical section as
      // takeover+lifecycle-create (PR 4 seam note) so a second send observes the stream row
      // and its placeholder together — except on the best-effort insert failure below, where
      // the placeholder is skipped and only the stream row exists (named honestly, not an
      // invariant). Skipped when pre-aborted — the user pressed Stop before streamText ever
      // ran, so there is no generation to show and no execute-end/onFinish write will ever
      // arrive to flip this row out of 'streaming'.
      //
      // Own try/catch, matching every other operation in this closure (takeOverConversationStreams,
      // createStreamLifecycle): `run` must never throw while the advisory lock is held, or
      // start-generation-exclusive.ts's caller misclassifies it as lock-machinery failure and
      // invokes `run` a SECOND time, unlocked — double generation, double billing. Best-effort:
      // a failed placeholder just means history can't show this entry mid-stream; the generation
      // itself still proceeds.
      if (!streamLifecycle.preAborted) {
        try {
          // A History delete permitted between the user-message write and here
          // must not plant an isActive:true 'streaming' row under a conversation
          // already gone from every listing (review finding —
          // chatgpt-codex-connector on PR #2299). The atomic re-check lives in
          // the repository method. An absent conversation row is tolerated on
          // the page leg (its eager `createConversation` call is best-effort);
          // only an explicitly inactive row skips.
          const { inserted } =
            args.scope.kind === 'page'
              ? await messageRepository.insertPageStreamingPlaceholder({
                  messageId: args.messageId,
                  pageId: args.scope.pageId,
                  conversationId: args.conversationId,
                  triggeredBy: { userId: args.userId, browserSessionId: args.browserSessionId },
                })
              : await messageRepository.insertGlobalStreamingPlaceholder({
                  messageId: args.messageId,
                  conversationId: args.conversationId,
                  userId: args.scope.userId,
                  triggeredBy: { userId: args.userId, browserSessionId: args.browserSessionId },
                });
          if (!inserted) {
            log.warn(`${label}: skipped placeholder assistant row, conversation no longer active`, {
              messageId: args.messageId,
              conversationId: args.conversationId,
            });
          }
        } catch (error) {
          log.warn(`${label}: placeholder assistant row INSERT failed`, {
            messageId: args.messageId,
            conversationId: args.conversationId,
            error: error instanceof Error ? error.message : 'unknown',
          });
        }
      }

      return streamLifecycle;
    },
  });

  return generation.result;
}

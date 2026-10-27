import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { streamChannelRegistry, type StreamMeta } from '@/lib/ai/core/stream-channel-registry';
import type { StreamChannel } from '@/lib/ai/core/stream-channel';

/**
 * What a joiner is actually looking at, once the in-process registry has been asked.
 *
 * ── THE PROBLEM THIS SOLVES IS AN AUTHORIZATION-ORDERING ONE ────────────────────────────────
 *
 * `stream-join`'s first gate was `streamChannelRegistry.getMeta(messageId)`, and it sat BEFORE
 * the authz block. Not by oversight — structurally. The authz inputs (pageId, conversationId,
 * the stream's owner) lived in the same in-memory entry as the frames, so there was nothing to
 * authorize against until the registry answered. A registry miss therefore had to 404, and at
 * N>1 a registry miss is the ORDINARY case: the channel is a process-local Map, so a join that
 * load-balances anywhere but the generating instance finds nothing, whatever the stream's real
 * state is. The route's 404 said "no such stream" about streams that were very much running.
 *
 * `ai_stream_sessions` already holds every one of those authz inputs — `stream-lifecycle.ts`
 * writes the row and the registry entry from the SAME values in the same function — so on a
 * miss they can simply be read. This module does that, and maps the row to EXACTLY the
 * `StreamMeta` shape the registry produces (`pageId ← channelId`, everything else one-for-one).
 *
 * THAT IS THE WHOLE TRICK, and it is worth stating because the tempting alternative is much
 * worse: because the meta shape is identical, the route's authz block is UNCHANGED.
 * `parseGlobalChannelId` → `canUserViewPage` → `canSubscribeToStream`, and the 5s revocation
 * recheck, all run verbatim over DB-sourced meta. There is no second authorization path to keep
 * in sync with the first — which is how a cross-instance feature quietly acquires a weaker
 * permission model than the local one it mirrors.
 *
 * `filterSubscribableStreams` is deliberately not used here: it is the BATCHED form, for the
 * `active-streams` listing. The single-row primitive is `canSubscribeToStream`, which the route
 * already calls.
 */

export type StreamJoinContext =
  /** The generation is running HERE. Frames come from memory, as they always have. */
  | { kind: 'local'; meta: StreamMeta; channel: StreamChannel }
  /**
   * The row says `streaming`, but not on this instance. A real, live generation this process
   * cannot see — which until now was indistinguishable from "does not exist".
   */
  | { kind: 'remote'; meta: StreamMeta }
  /**
   * The generation is over. Distinct from `missing` because the CLIENT must be able to tell
   * "it finished, reload the durable message" from "there is nothing here" — the same
   * distinction `aborted` carries on a local end.
   */
  | { kind: 'terminal'; meta: StreamMeta; aborted: boolean }
  /** No channel, no row. The only honest 404. */
  | { kind: 'missing' };

/**
 * Resolve what this instance can say about a messageId.
 *
 * The registry is asked FIRST and its answer is authoritative — a locally-owned channel is the
 * live object, and going to the DB for a row it already holds would be a round trip for nothing.
 * Only a miss pays for the read, and only one row.
 *
 * A failed read answers `missing`. That is the same degradation the route had before this
 * module existed (a registry miss 404'd unconditionally), so a DB blip costs a joiner a retry
 * rather than a wrong answer about who may see what.
 */
export const resolveStreamJoinContext = async (messageId: string): Promise<StreamJoinContext> => {
  const localMeta = streamChannelRegistry.getMeta(messageId);
  const localChannel = streamChannelRegistry.get(messageId);
  // Both, or neither — the registry sets and clears them together. Requiring both rather than
  // trusting one is what keeps a half-torn-down entry from being served as `local` with no
  // channel to subscribe to.
  if (localMeta && localChannel) return { kind: 'local', meta: localMeta, channel: localChannel };

  let row: {
    channelId: string;
    userId: string;
    displayName: string;
    conversationId: string;
    browserSessionId: string;
    status: 'streaming' | 'complete' | 'aborted';
  } | undefined;

  try {
    [row] = await db
      .select({
        // `pageId` in the registry's vocabulary — a real pageId for page-chat, or a synthetic
        // `user:<id>:global` id. `stream-lifecycle.ts` writes both columns from the same value.
        channelId: aiStreamSessions.channelId,
        userId: aiStreamSessions.userId,
        displayName: aiStreamSessions.displayName,
        conversationId: aiStreamSessions.conversationId,
        browserSessionId: aiStreamSessions.browserSessionId,
        status: aiStreamSessions.status,
      })
      .from(aiStreamSessions)
      .where(eq(aiStreamSessions.messageId, messageId))
      .limit(1);
  } catch (error) {
    loggers.ai.warn('stream-join-context: could not read the session row', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { kind: 'missing' };
  }

  if (!row) return { kind: 'missing' };

  const meta: StreamMeta = {
    pageId: row.channelId,
    userId: row.userId,
    displayName: row.displayName,
    conversationId: row.conversationId,
    browserSessionId: row.browserSessionId,
  };

  // `status` is NOT liveness — a crashed generation leaves a row claiming 'streaming' forever
  // (see stream-liveness.ts). That is fine here and deliberately not re-litigated: a `remote`
  // context only promises "the row has not been settled", and whatever follows it discovers the
  // truth from the frame log and the row's own terminal write. Applying a heartbeat predicate
  // here would make a joiner's answer disagree with `/active-streams`, which is already the
  // authoritative liveness surface.
  if (row.status === 'streaming') return { kind: 'remote', meta };

  return { kind: 'terminal', meta, aborted: row.status === 'aborted' };
};

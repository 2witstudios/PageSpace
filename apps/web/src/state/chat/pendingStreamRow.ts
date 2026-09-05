import type { Entity } from '@adobe/data/ecs';
import type { PendingStream } from '@/stores/pendingStreams/applyAddStream';
import type { ChatDataRead } from './chat-data-plugin';

/**
 * SPIKE (@adobe/data adoption evidence). Column ⇄ `PendingStream` projection.
 *
 * `startedAt`/`lastSeq` are optional on `PendingStream` but a component column
 * cannot be "sometimes missing" without leaving the archetype, so absence is
 * encoded as `null` and projected back to `undefined` here. Vitest `toEqual`
 * ignores explicitly-`undefined` keys, so the existing store assertions
 * (`expect(stream).toEqual({ ...BASE_STREAM, parts: [] })`) hold unchanged.
 */
export const readPendingStream = (store: ChatDataRead, entity: Entity): PendingStream | null => {
  const messageId = store.get(entity, 'streamMessageId');
  const pageId = store.get(entity, 'streamPageId');
  const conversationId = store.get(entity, 'streamConversationId');
  const triggeredBy = store.get(entity, 'streamTriggeredBy');
  if (messageId === undefined || pageId === undefined || conversationId === undefined || triggeredBy === null || triggeredBy === undefined) {
    return null;
  }
  const startedAt = store.get(entity, 'streamStartedAt') ?? null;
  const lastSeq = store.get(entity, 'streamLastSeq') ?? null;
  return {
    messageId,
    pageId,
    conversationId,
    triggeredBy,
    parts: store.get(entity, 'streamParts') ?? [],
    isOwn: store.get(entity, 'streamIsOwn') ?? false,
    startedAt: startedAt ?? undefined,
    lastSeq: lastSeq ?? undefined,
  };
};

/**
 * Every live stream on a page, in insertion order.
 *
 * This is the ECS index doing what `getRemotePageStreams` could not: a bucket
 * lookup on `streamPageId` instead of iterating the app-wide stream map and
 * filtering afterwards (the epic's filed `D —` performance finding).
 */
export const readPageStreams = (store: ChatDataRead, pageId: string): PendingStream[] => {
  const streams: PendingStream[] = [];
  for (const entity of store.indexes.streamsByPageId.find({ streamPageId: pageId })) {
    const stream = readPendingStream(store, entity);
    if (stream !== null) streams.push(stream);
  }
  return streams;
};

import type { UIMessage } from 'ai';
import type { PendingStream, PendingStreamsMap } from '@/stores/pendingStreams/applyAddStream';
import type { ChatStateDatabase } from '../chat-state-plugin';

type UIMessagePart = UIMessage['parts'][number];

/**
 * SPIKE (@adobe/data adoption evidence). The zustand-shaped facade over the
 * ported pending-streams state — see `conversationMessagesFacade` for why the
 * facade exists at all.
 */
export interface PendingStreamsFacadeState {
  streams: PendingStreamsMap;
  addStream: (stream: Omit<PendingStream, 'parts' | 'lastSeq'> & { parts?: UIMessagePart[] }) => void;
  appendPart: (messageId: string, part: UIMessagePart) => void;
  setStreamParts: (messageId: string, parts: UIMessagePart[], seq: number) => void;
  removeStream: (messageId: string) => void;
  clearPageStreams: (pageId: string) => void;
  getRemotePageStreams: (pageId: string) => PendingStream[];
  getOwnStreams: (pageId: string) => PendingStream[];
}

export interface PendingStreamsFacade {
  getState: () => PendingStreamsFacadeState;
  /** Only the `{ streams: new Map() }` teardown form is meaningful on an ECS container. */
  setState: (partial: { streams: PendingStreamsMap }) => void;
}

export const createPendingStreamsFacade = (db: ChatStateDatabase): PendingStreamsFacade => {
  const readStreams = (): PendingStreamsMap => {
    const streams: PendingStreamsMap = new Map();
    for (const entity of db.select(['streamMessageId'])) {
      const stream = db.actions.getStream(db.get(entity, 'streamMessageId') ?? '');
      if (stream !== null) streams.set(stream.messageId, stream);
    }
    return streams;
  };

  return {
    getState: () => ({
      streams: readStreams(),
      addStream: (stream) => {
        db.transactions.addStream(stream);
      },
      appendPart: (messageId, part) => {
        db.transactions.appendPart({ messageId, part });
      },
      setStreamParts: (messageId, parts, seq) => {
        db.transactions.setStreamParts({ messageId, parts, seq });
      },
      removeStream: (messageId) => {
        db.transactions.removeStream(messageId);
      },
      clearPageStreams: (pageId) => {
        db.transactions.clearPageStreams(pageId);
      },
      getRemotePageStreams: (pageId) => db.actions.getRemotePageStreams(pageId),
      getOwnStreams: (pageId) => db.actions.getOwnStreams(pageId),
    }),
    setState: (partial) => {
      if (partial.streams.size > 0) {
        throw new Error(
          'pendingStreamsFacade.setState only supports the empty-reset form; seed state through transactions.',
        );
      }
      db.transactions.resetChatState();
    },
  };
};

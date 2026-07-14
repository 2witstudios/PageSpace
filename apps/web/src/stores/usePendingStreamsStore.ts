import { create } from 'zustand';
import { applyAddStream } from '@/stores/pendingStreams/applyAddStream';
import { applyAppendPart } from '@/stores/pendingStreams/applyAppendPart';
import { applySetStreamParts } from '@/stores/pendingStreams/applySetStreamParts';
import { applyRemoveStream } from '@/stores/pendingStreams/applyRemoveStream';
import { applyClearPageStreams } from '@/stores/pendingStreams/applyClearPageStreams';
import type { PendingStream, PendingStreamsMap } from '@/stores/pendingStreams/applyAddStream';

export type { PendingStream };

type UIMessagePart = PendingStream['parts'][number];

interface PendingStreamsState {
  streams: PendingStreamsMap;
  /**
   * No-op when the messageId already exists — so initial `parts` (a restored
   * server snapshot) seed at most once even when co-mounted surfaces
   * bootstrap the same channel concurrently.
   */
  addStream: (stream: Omit<PendingStream, 'parts' | 'lastSeq'> & { parts?: UIMessagePart[] }) => void;
  appendPart: (messageId: string, part: UIMessagePart) => void;
  /**
   * Replace-semantics write for the own-stream mirror: sets `parts` wholesale
   * rather than merging, gated by `seq` (see `applySetStreamParts`).
   */
  setStreamParts: (messageId: string, parts: UIMessagePart[], seq: number) => void;
  removeStream: (messageId: string) => void;
  clearPageStreams: (pageId: string) => void;
  getRemotePageStreams: (pageId: string) => PendingStream[];
  getOwnStreams: (pageId: string) => PendingStream[];
}

export const usePendingStreamsStore = create<PendingStreamsState>((set, get) => ({
  streams: new Map(),

  addStream: (stream) => {
    set((state) => ({ streams: applyAddStream(state.streams, stream) }));
  },

  appendPart: (messageId, part) => {
    set((state) => ({ streams: applyAppendPart(state.streams, { messageId, part }) }));
  },

  setStreamParts: (messageId, parts, seq) => {
    set((state) => ({ streams: applySetStreamParts(state.streams, { messageId, parts, seq }) }));
  },

  removeStream: (messageId) => {
    set((state) => ({ streams: applyRemoveStream(state.streams, messageId) }));
  },

  clearPageStreams: (pageId) => {
    set((state) => ({ streams: applyClearPageStreams(state.streams, pageId) }));
  },

  getRemotePageStreams: (pageId) => {
    return Array.from(get().streams.values()).filter((s) => s.pageId === pageId);
  },

  getOwnStreams: (pageId) => {
    return Array.from(get().streams.values()).filter(
      (s) => s.pageId === pageId && s.isOwn,
    );
  },
}));

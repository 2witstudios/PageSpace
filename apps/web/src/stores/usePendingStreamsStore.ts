import { create } from 'zustand';
import type { UIMessage } from 'ai';
import { appendPart as appendPartPure } from '@/lib/ai/streams/appendPart';

type UIMessagePart = UIMessage['parts'][number];

export interface PendingStream {
  messageId: string;
  pageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string };
  parts: UIMessagePart[];
  isOwn: boolean;
}

interface PendingStreamsState {
  streams: Map<string, PendingStream>;
  addStream: (stream: Omit<PendingStream, 'parts'>) => void;
  appendPart: (messageId: string, part: UIMessagePart) => void;
  removeStream: (messageId: string) => void;
  clearPageStreams: (pageId: string) => void;
  getRemotePageStreams: (pageId: string) => PendingStream[];
  getOwnStreams: (pageId: string) => PendingStream[];
}

export const usePendingStreamsStore = create<PendingStreamsState>((set, get) => ({
  streams: new Map(),

  addStream: (stream) => {
    set((state) => {
      if (state.streams.has(stream.messageId)) return state;
      const next = new Map(state.streams);
      next.set(stream.messageId, { ...stream, parts: [] });
      return { streams: next };
    });
  },

  appendPart: (messageId, part) => {
    set((state) => {
      const existing = state.streams.get(messageId);
      if (!existing) return state;
      const next = new Map(state.streams);
      next.set(messageId, { ...existing, parts: appendPartPure(existing.parts, part) });
      return { streams: next };
    });
  },

  removeStream: (messageId) => {
    set((state) => {
      const next = new Map(state.streams);
      next.delete(messageId);
      return { streams: next };
    });
  },

  clearPageStreams: (pageId) => {
    set((state) => ({
      streams: new Map([...state.streams].filter(([, s]) => s.pageId !== pageId)),
    }));
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

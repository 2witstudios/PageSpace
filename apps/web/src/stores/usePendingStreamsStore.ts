import { create } from 'zustand';

export interface PendingStream {
  messageId: string;
  pageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string };
  text: string;
}

interface PendingStreamsState {
  streams: Map<string, PendingStream>;
  addStream: (stream: Omit<PendingStream, 'text'>) => void;
  appendText: (messageId: string, chunk: string) => void;
  removeStream: (messageId: string) => void;
  clearPageStreams: (pageId: string) => void;
  getRemotePageStreams: (pageId: string) => PendingStream[];
}

export const usePendingStreamsStore = create<PendingStreamsState>((set, get) => ({
  streams: new Map(),

  addStream: (stream) => {
    set((state) => {
      const next = new Map(state.streams);
      next.set(stream.messageId, { ...stream, text: '' });
      return { streams: next };
    });
  },

  appendText: (messageId, chunk) => {
    set((state) => {
      const existing = state.streams.get(messageId);
      if (!existing) return state;
      const next = new Map(state.streams);
      next.set(messageId, { ...existing, text: existing.text + chunk });
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
    set((state) => {
      const next = new Map(state.streams);
      for (const [id, stream] of next) {
        if (stream.pageId === pageId) next.delete(id);
      }
      return { streams: next };
    });
  },

  getRemotePageStreams: (pageId) => {
    return Array.from(get().streams.values()).filter((s) => s.pageId === pageId);
  },
}));

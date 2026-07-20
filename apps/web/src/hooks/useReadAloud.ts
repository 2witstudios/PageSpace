'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { UIMessage } from 'ai';
import { getTextSinceLastUserTurn } from '@/lib/ai/streams/getTextSinceLastUserTurn';
import { flushForTts } from '@/lib/voice/chunkForTts';
import {
  startReadAloud,
  stopReadAloud,
  isReadAloudPlaying,
  subscribeReadAloud,
} from '@/lib/voice/readAloudPlayer';

const getServerSnapshot = () => false;

/**
 * On-demand TTS for "read the assistant's last turn aloud" — distinct from
 * full hands-free Voice Mode. Every call site shares the same module-level
 * playback singleton (`readAloudPlayer`), so starting or stopping from any
 * mounted chat surface acts on the one real audio source.
 */
export function useReadAloud() {
  const isReadingAloud = useSyncExternalStore(subscribeReadAloud, isReadAloudPlaying, getServerSnapshot);

  const toggleReadAloud = useCallback(
    (messages: readonly UIMessage[]) => {
      if (isReadAloudPlaying()) {
        stopReadAloud();
        return;
      }
      const text = getTextSinceLastUserTurn(messages);
      if (!text.trim()) return;
      startReadAloud(flushForTts(text));
    },
    []
  );

  return { isReadingAloud, toggleReadAloud };
}

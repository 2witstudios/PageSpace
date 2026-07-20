'use client';

import { useCallback } from 'react';
import type { UIMessage } from 'ai';
import { useVoiceMode } from './useVoiceMode';
import { getTextSinceLastUserTurn } from '@/lib/ai/streams/getTextSinceLastUserTurn';
import { flushForTts } from '@/lib/voice/chunkForTts';

/**
 * On-demand TTS for "read the assistant's last turn aloud" — distinct from
 * full hands-free Voice Mode. Owns its own `useVoiceMode()` instance, so
 * callers must not use this while Voice Mode is active on the same surface:
 * both instances share the same global voice-state store but have
 * independent audio playback, so one can't stop audio started by the other.
 */
export function useReadAloud() {
  const { isSpeaking, queueSentence, stopSpeaking } = useVoiceMode();

  const toggleReadAloud = useCallback(
    (messages: readonly UIMessage[]) => {
      if (isSpeaking) {
        stopSpeaking();
        return;
      }
      const text = getTextSinceLastUserTurn(messages);
      if (!text.trim()) return;
      flushForTts(text).forEach((chunk) => queueSentence(chunk));
    },
    [isSpeaking, stopSpeaking, queueSentence]
  );

  return { isReadingAloud: isSpeaking, toggleReadAloud };
}

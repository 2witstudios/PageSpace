'use client';

import { useCallback } from 'react';
import type { UIMessage } from 'ai';
import { useVoiceModeStore } from '@/stores/useVoiceModeStore';
import { useDictationActivityStore } from '@/hooks/useSpeechRecognition';
import { getTextSinceLastUserTurn, hasTextSinceLastUserTurn } from '@/lib/ai/streams/getTextSinceLastUserTurn';
import { flushForTts } from '@/lib/voice/chunkForTts';
import {
  startReadAloud,
  stopReadAloud,
  useReadAloudPlayerStore,
} from '@/lib/voice/readAloudPlayer';

/**
 * On-demand TTS for "read the assistant's last turn aloud" — distinct from
 * full hands-free Voice Mode. Every call site shares the same module-level
 * playback singleton (`readAloudPlayer`), so starting or stopping from any
 * mounted chat surface acts on the one real audio source.
 *
 * Unavailable while Voice Mode is enabled, or mic dictation is active, on
 * ANY surface (not just the current one) — both are separate microphone
 * captures elsewhere that would overlap with this audio.  `readAloudPlayer`
 * itself also stops any in-progress read-aloud the moment either turns on,
 * so this is a pre-check for starting a new read, not the only guard.
 */
export function useReadAloud() {
  const isReadingAloud = useReadAloudPlayerStore((s) => s.isPlaying);
  const isVoiceModeEnabled = useVoiceModeStore((s) => s.isEnabled);
  const isDictationActive = useDictationActivityStore((s) => s.activeCount > 0);
  const blocked = isVoiceModeEnabled || isDictationActive;

  const toggleReadAloud = useCallback(
    (messages: readonly UIMessage[]) => {
      if (useReadAloudPlayerStore.getState().isPlaying) {
        stopReadAloud();
        return;
      }
      if (blocked) return;
      const text = getTextSinceLastUserTurn(messages);
      if (!text.trim()) return;
      startReadAloud(flushForTts(text));
    },
    [blocked]
  );

  const canReadAloud = useCallback(
    (messages: readonly UIMessage[]) => !blocked && hasTextSinceLastUserTurn(messages),
    [blocked]
  );

  return { isReadingAloud, toggleReadAloud, canReadAloud };
}

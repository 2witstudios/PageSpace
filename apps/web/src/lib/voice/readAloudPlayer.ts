'use client';

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useVoiceModeStore } from '@/stores/useVoiceModeStore';

/**
 * Module-singleton "read aloud" audio player, deliberately independent of
 * React component lifecycles and of `useVoiceMode`'s per-instance
 * AudioContext/audioSource refs.
 *
 * Read Aloud can be triggered from multiple mounted chat surfaces at once
 * (e.g. the right-sidebar chat tab alongside the main AiChatView/
 * GlobalAssistantView content). A per-component `useVoiceMode()` instance
 * only tracks its OWN AudioContext locally while sharing global voice state
 * via the store — so a second instance's "stop" call clears shared state but
 * can't reach the first instance's actual playing AudioBufferSourceNode, and
 * an unmounting instance never resets that shared state either. Keeping the
 * one real audio source at module scope means there is only ever one thing
 * to stop, reachable from anywhere `useReadAloud()` is called.
 */

type Listener = () => void;

let audioContext: AudioContext | null = null;
let audioSource: AudioBufferSourceNode | null = null;
let queue: string[] = [];
let playing = false;
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => { listener(); });
}

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

async function synthesize(text: string): Promise<AudioBuffer | null> {
  const { ttsVoice, ttsSpeed } = useVoiceModeStore.getState();
  // Created before the network await so the browser still credits this
  // AudioContext to the user gesture that triggered playback.
  const ctx = getAudioContext();
  try {
    const response = await fetchWithAuth('/api/voice/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: ttsVoice, speed: ttsSpeed }),
    });
    if (!response.ok) return null;
    const audioData = await response.arrayBuffer();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return await ctx.decodeAudioData(audioData);
  } catch {
    return null;
  }
}

async function playNext(): Promise<void> {
  if (!playing) return;
  const text = queue.shift();
  if (text === undefined) {
    playing = false;
    notify();
    return;
  }

  const buffer = await synthesize(text);
  // Stopped while this chunk was being synthesized — discard the result.
  if (!playing) return;
  if (!buffer) {
    // Skip a chunk that failed to synthesize rather than abandoning the rest.
    void playNext();
    return;
  }

  const ctx = getAudioContext();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  audioSource = source;
  source.onended = () => {
    if (audioSource === source) {
      audioSource = null;
      void playNext();
    }
  };
  source.start();
}

export function startReadAloud(chunks: string[]): void {
  stopReadAloud();
  if (chunks.length === 0) return;
  queue = [...chunks];
  playing = true;
  notify();
  void playNext();
}

export function stopReadAloud(): void {
  const wasPlaying = playing;
  if (audioSource) {
    try {
      audioSource.stop();
    } catch {
      // Already stopped.
    }
    audioSource = null;
  }
  queue = [];
  playing = false;
  if (wasPlaying) notify();
}

export function isReadAloudPlaying(): boolean {
  return playing;
}

export function subscribeReadAloud(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

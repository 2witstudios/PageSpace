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

// Bumped by every stopReadAloud() call (including the implicit one at the
// start of startReadAloud()). A `playNext`/`synthesize` chain captures the
// generation it was started under and re-checks it after every await:
// `playing` alone can't tell "this run was stopped" apart from "this run was
// stopped AND THEN a newer run began" — in the latter case `playing` is true
// again by the time the stale chain resumes, so it would otherwise create a
// second AudioBufferSourceNode that plays concurrently with the new run's.
let generation = 0;

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

async function playNext(runId: number): Promise<void> {
  if (runId !== generation) return;
  const text = queue.shift();
  if (text === undefined) {
    playing = false;
    notify();
    return;
  }

  const buffer = await synthesize(text);
  // A stop, or a stop-then-restart, happened while this chunk was
  // synthesizing — discard the result rather than letting a stale run play.
  if (runId !== generation) return;
  if (!buffer) {
    // Skip a chunk that failed to synthesize rather than abandoning the rest.
    void playNext(runId);
    return;
  }

  const ctx = getAudioContext();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  audioSource = source;
  source.onended = () => {
    if (runId !== generation) return;
    if (audioSource === source) {
      audioSource = null;
      void playNext(runId);
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
  void playNext(generation);
}

export function stopReadAloud(): void {
  generation++;
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

'use client';

import { create } from 'zustand';
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
 *
 * Only the boolean "is something playing" needs to be observable by React,
 * so that alone lives in a tiny zustand store (this codebase's established
 * pattern for shared, cross-component state — see the sibling
 * `useVoiceModeStore`). The actual audio machinery (AudioContext, the
 * current source, the chunk queue, the race-guard generation counter) stays
 * in plain module variables outside React entirely.
 */

interface ReadAloudPlayerState {
  isPlaying: boolean;
}

export const useReadAloudPlayerStore = create<ReadAloudPlayerState>(() => ({
  isPlaying: false,
}));

function setPlaying(isPlaying: boolean): void {
  useReadAloudPlayerStore.setState({ isPlaying });
}

let audioContext: AudioContext | null = null;
let audioSource: AudioBufferSourceNode | null = null;
let queue: string[] = [];
// The in-flight synthesis request, if any — aborted by stopReadAloud() so a
// stopped chunk's billed TTS call is actually cancelled, not just ignored.
let activeAbortController: AbortController | null = null;

// Bumped by every stopReadAloud() call (including the implicit one at the
// start of startReadAloud()). A `playNext`/`synthesize` chain captures the
// generation it was started under and re-checks it after every await:
// `isPlaying` alone can't tell "this run was stopped" apart from "this run
// was stopped AND THEN a newer run began" — in the latter case `isPlaying`
// is true again by the time the stale chain resumes, so it would otherwise
// create a second AudioBufferSourceNode that plays concurrently with the
// new run's.
let generation = 0;

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
  const controller = new AbortController();
  activeAbortController = controller;
  try {
    const response = await fetchWithAuth('/api/voice/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: ttsVoice, speed: ttsSpeed }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const audioData = await response.arrayBuffer();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return await ctx.decodeAudioData(audioData);
  } catch {
    return null;
  } finally {
    // Only clear if still ours — a stop-then-restart race can leave a newer
    // call's controller as the active one while this (stale) call is still
    // unwinding; clearing unconditionally would drop the newer reference and
    // leave IT un-abortable by a later stop.
    if (activeAbortController === controller) {
      activeAbortController = null;
    }
  }
}

async function playNext(runId: number): Promise<void> {
  if (runId !== generation) return;
  const text = queue.shift();
  if (text === undefined) {
    setPlaying(false);
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
    // Within one generation only one source is ever live at a time — a new
    // one is only created after the previous one's onended fired (or after a
    // stop, which bumps generation and is already excluded above) — so
    // audioSource is guaranteed to still be this source here.
    audioSource = null;
    void playNext(runId);
  };
  source.start();
}

export function startReadAloud(chunks: string[]): void {
  ensureVoiceModeStopsReadAloud();
  stopReadAloud();
  if (chunks.length === 0) return;
  queue = [...chunks];
  setPlaying(true);
  void playNext(generation);
}

export function stopReadAloud(): void {
  generation++;
  activeAbortController?.abort();
  activeAbortController = null;
  if (audioSource) {
    try {
      audioSource.stop();
    } catch {
      // Already stopped.
    }
    audioSource = null;
  }
  queue = [];
  // Guard against a redundant store update (and subscriber notification):
  // startReadAloud() always calls this first to reset any prior run, even
  // when nothing was playing.
  if (useReadAloudPlayerStore.getState().isPlaying) {
    setPlaying(false);
  }
}

export function isReadAloudPlaying(): boolean {
  return useReadAloudPlayerStore.getState().isPlaying;
}

// Enforced here (not per call-site) so the invariant holds no matter which UI
// entry point enables Voice Mode, present or future: a mic-capturing live
// call must never run concurrently with this module's own TTS audio, since
// each has its own separate AudioContext and would otherwise be picked up by
// Voice Mode's microphone as if it were user speech.
//
// Registered lazily (on first startReadAloud(), not at module import time)
// so merely importing this module — e.g. a component under test that renders
// but never exercises Read Aloud — never touches useVoiceModeStore.subscribe.
// By the time any audio could actually be playing, this has always already
// run, since startReadAloud() is the only path that starts playback.
let voiceModeSubscriptionRegistered = false;
function ensureVoiceModeStopsReadAloud(): void {
  if (voiceModeSubscriptionRegistered) return;
  voiceModeSubscriptionRegistered = true;
  useVoiceModeStore.subscribe((state, prevState) => {
    if (state.isEnabled && !prevState.isEnabled) {
      stopReadAloud();
    }
  });
}

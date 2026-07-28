'use client';

import { create } from 'zustand';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useVoiceModeStore } from '@/stores/useVoiceModeStore';
import { useDictationActivityStore } from '@/hooks/useSpeechRecognition';

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
 *
 * Mutually exclusive with two other microphone-capturing features, each
 * with the same cross-surface problem: a live Voice Mode call
 * (`useVoiceModeStore`) and basic mic dictation (`useDictationActivityStore`
 * in `useSpeechRecognition.ts`, one per `ChatInput` instance). Either one's
 * mic could otherwise pick up this module's own TTS audio and transcribe it
 * back into a draft or into Voice Mode's own turn. See `ensureReadAloudReady`.
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

async function synthesize(text: string, runId: number): Promise<AudioBuffer | null> {
  const { ttsVoice, ttsSpeed } = useVoiceModeStore.getState();
  const controller = new AbortController();
  activeAbortController = controller;
  // A stale, already-superseded run (from a stop-then-restart) failing for
  // its own unrelated reason must be a full no-op: no toast, and — crucially
  // — no stopReadAloud() either, since that would tear down a newer run that
  // has nothing to do with this one's failure. Only the run that is still
  // current gets to surface an error and stop the queue.
  const handleFailure = (message: string) => {
    if (runId !== generation) return;
    toast.error(message);
    stopReadAloud();
  };
  try {
    // Created before the network await so the browser still credits this
    // AudioContext to the user gesture that triggered playback. Inside the
    // try block (not before it) so a creation failure — quota exhausted,
    // Web Audio unsupported — gets the same surface-and-stop handling as any
    // other synthesis failure, rather than rejecting playNext()'s
    // fire-and-forget call unhandled and leaving isPlaying stuck true with
    // no explanation and no audio.
    const ctx = getAudioContext();
    const response = await fetchWithAuth('/api/voice/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: ttsVoice, speed: ttsSpeed }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // A systemic failure (out of credits, rate-limited, misconfigured) —
      // every remaining chunk would fail identically, so surface it and stop
      // the whole run instead of silently skip-retrying it chunk by chunk.
      // playNext()'s generation check (bumped by handleFailure's
      // stopReadAloud() call) is what actually prevents the skip-retry, not
      // this branch.
      const errorData = await response.json().catch(() => ({}) as Record<string, unknown>);
      const message =
        (typeof errorData.message === 'string' && errorData.message) ||
        (typeof errorData.error === 'string' && errorData.error) ||
        'Could not read this reply aloud.';
      handleFailure(message);
      return null;
    }
    const audioData = await response.arrayBuffer();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return await ctx.decodeAudioData(audioData);
  } catch (err) {
    // An AbortError here means WE intentionally cancelled this request (via
    // stopReadAloud()'s controller.abort()) — expected, nothing to surface.
    // Any other exception (network failure, a corrupted/undecodable
    // response, AudioContext.resume() failing) is unexpected and would
    // otherwise silently truncate or drop the reply with zero explanation,
    // so it gets the same surface-and-stop treatment as a non-ok response.
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      handleFailure('Could not read this reply aloud. Please try again.');
    }
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

  const buffer = await synthesize(text, runId);
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
  ensureMutualExclusionSubscriptions();
  // synthesize() reads ttsVoice/ttsSpeed straight from useVoiceModeStore
  // without ever mounting useVoiceMode() — which is what used to trigger
  // this load on mount — so a user's persisted voice choice would otherwise
  // be silently ignored the first time they use Read Aloud without ever
  // having opened the full Voice Mode panel. Idempotent and cheap, so it's
  // just re-run on every start rather than gated behind a one-time flag.
  useVoiceModeStore.getState().loadSettings();
  stopReadAloud();
  if (chunks.length === 0) return;
  // Re-validate live state here, not just via the subscriptions above: a
  // caller's "may I start?" check (useReadAloud's `blocked`) can be a stale
  // React closure, and the subscriptions only fire on a FUTURE
  // inactive-to-active transition — neither catches "already active by the
  // time this specific call runs" (e.g. rapid clicks across two surfaces).
  if (useVoiceModeStore.getState().isEnabled || useDictationActivityStore.getState().activeCount > 0) {
    return;
  }
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

// Registered lazily (on first startReadAloud(), not at module import time)
// so merely importing this module — e.g. a component under test that
// renders but never exercises Read Aloud — never touches these other
// stores' `.subscribe`. By the time any audio could actually be playing,
// this has always already run, since startReadAloud() is the only path
// that starts playback. Guarded by a one-time flag (unlike loadSettings()
// above) because subscribing more than once would leak duplicate listeners.
//
// A live Voice Mode call or active mic dictation each capture the
// microphone — this module's own TTS audio must never play concurrently
// with either, or it risks being picked up as if it were user speech.
// Enforced here (not per call-site) so the invariant holds no matter which
// UI entry point triggers either, present or future.
let subscriptionsRegistered = false;
function ensureMutualExclusionSubscriptions(): void {
  if (subscriptionsRegistered) return;
  subscriptionsRegistered = true;
  useVoiceModeStore.subscribe((state, prevState) => {
    if (state.isEnabled && !prevState.isEnabled) {
      stopReadAloud();
    }
  });
  useDictationActivityStore.subscribe((state, prevState) => {
    if (state.activeCount > 0 && prevState.activeCount === 0) {
      stopReadAloud();
    }
  });
}

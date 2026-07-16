import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useEditingStore } from '@/stores/useEditingStore';
import { getAIErrorMessage } from '@/lib/ai/shared/error-messages';
import { isThenable } from '@/lib/ai/streams/isThenable';

/**
 * Manages deterministic handoff between pending send and streaming state.
 *
 * The hook:
 * 1. Registers pendingSend when wrapSend() is called
 * 2. Watches for the STREAM ENTRY to appear in the store, OR an error to occur
 * 3. Clears pendingSend when the stream takes over or on error (deterministic)
 * 4. Includes a safety timeout (15s) to auto-clear orphaned pendingSend
 *
 * This ensures UI refresh protection is continuous from send button click
 * through streaming completion, without relying on arbitrary timeouts.
 *
 * THE END-CONDITION IS STORE PRESENCE, NOT useChat's STATUS (PR 5A, leaf 5.7).
 *
 * `isStreamLive` is "a live stream entry exists in usePendingStreamsStore for this
 * conversation" — passed in by the surface (via the useConversationActiveStream facade) rather
 * than read here, so this hook stays ignorant of the state container.
 *
 * The old end-condition (`status === 'submitted' || status === 'streaming'`) ended the
 * pendingSend the instant useChat flipped to 'submitted' — i.e. BEFORE the request had even been
 * issued, and 0.5-3s before any stream existed. Nothing held the registration across that gap
 * except useChat's own status, which is exactly the signal this epic is removing from the render
 * path: it is idle for a bootstrapped stream after a refresh, and for every remote or
 * cross-instance stream, so a pendingSend that handed off to it handed off to nothing.
 *
 * Handing off to the store entry instead means the two overlap rather than gap: the pendingSend
 * covers the submitted window, the store entry covers the stream, and
 * `deriveStreamingRegistrations` ORs them into one continuous registration.
 */
export function useSendHandoff(
  conversationId: string | null,
  status: 'ready' | 'submitted' | 'streaming' | 'error',
  isStreamLive: boolean,
): {
  wrapSend: <T>(sendFn: () => T) => T | undefined;
  /**
   * The conversation the in-flight send was made in, or null. This is the pendingSend key —
   * the only name the client holds during the submitted window, and what Stop aborts by there
   * (see decideStopAction).
   */
  pendingSendConversationId: string | null;
} {
  const hasPendingSendRef = useRef(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  // State, not just a ref: the Stop button has to re-render when this appears/disappears.
  const [pendingSendConversationId, setPendingSendConversationId] = useState<string | null>(null);

  // Effect-based handoff: clear pendingSend when the stream entry takes over OR on error
  useEffect(() => {
    if (!conversationId) return;
    // Hold the name ONLY while the request is genuinely in flight with nothing to hand off to:
    // status submitted/streaming AND no store entry yet. That is the window it exists to cover.
    //
    // Everything else is a resolution and must clear it:
    //   - `isStreamLive` — the stream took over; the registration now derives from the store entry.
    //   - `'error'`      — the request failed.
    //   - `'ready'`      — the request SETTLED. Crucially this covers Stop-during-the-submitted-
    //     window: useChat.stop() aborts the fetch and settles to 'ready', never 'error', and no
    //     assistant message was ever pushed so `isStreamLive` never becomes true. Excluding 'ready'
    //     leaked the name forever — and because all three surfaces OR it into their streaming flag,
    //     and the composer renders ONLY a Stop button while that is true, the conversation wedged
    //     unusable until unmount. 'ready' cannot arrive while the POST is still in flight, so
    //     treating it as a resolution is safe.
    //
    // NOT guarded on `hasPendingSendRef`: the 15s safety timeout may already have released the
    // editing-store hold on a slow send, and the name must still clear when that send resolves.
    if (!isStreamLive && (status === 'submitted' || status === 'streaming')) return;

    if (hasPendingSendRef.current) {
      hasPendingSendRef.current = false;
      useEditingStore.getState().endPendingSend(conversationId);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    }
    setPendingSendConversationId(null);
  }, [isStreamLive, status, conversationId]);

  // Cleanup on unmount or conversation change
  useEffect(() => {
    const savedConversationId = conversationId;
    return () => {
      if (hasPendingSendRef.current && savedConversationId) {
        useEditingStore.getState().endPendingSend(savedConversationId);
        hasPendingSendRef.current = false;
        setPendingSendConversationId(null);
      }
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [conversationId]);

  const wrapSend = useCallback(<T>(sendFn: () => T): T | undefined => {
    if (!conversationId) return undefined;

    hasPendingSendRef.current = true;
    setPendingSendConversationId(conversationId);
    useEditingStore.getState().startPendingSend(conversationId);

    // Safety timeout: release the EDITING-STORE hold if the stream never starts, so an orphaned
    // send cannot block SWR revalidation and auth refresh forever. That is all it is for.
    //
    // It deliberately does NOT clear `pendingSendConversationId`. That value is the only name Stop
    // has during the submitted window — no store entry exists until useChat pushes the assistant
    // message — so nulling it here armed a 15s self-destruct on Stop itself: on any send whose TTFB
    // ran long (cold provider, server-side retry, big context assembly, rate-limit backoff) the
    // button flipped back to Send and a later Stop resolved to 'none', cancelling the local fetch
    // and issuing no server abort while the generation kept running its write tools and kept
    // billing. The send is still in flight at t=15s; the user must still be able to stop it. It
    // clears when the send actually resolves — a stream entry appears, an error lands, or the
    // surface leaves the conversation.
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (hasPendingSendRef.current && conversationId) {
        console.warn('[useSendHandoff] Safety timeout: releasing orphaned editing-store hold');
        hasPendingSendRef.current = false;
        useEditingStore.getState().endPendingSend(conversationId);
      }
    }, 15000);

    // Shared by both failure paths: sendFn can throw synchronously (e.g. a guard
    // clause before any await) or return a promise that rejects later (e.g. an
    // awaited pre-send fetch) — either way pendingSend must clear immediately and
    // the caller sees an error, rather than sitting registered until the 15s
    // safety timeout with no visible feedback.
    const settleOnFailure = (error: unknown) => {
      hasPendingSendRef.current = false;
      setPendingSendConversationId(null);
      useEditingStore.getState().endPendingSend(conversationId);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      toast.error(getAIErrorMessage(error instanceof Error ? error.message : String(error)));
    };

    try {
      const result = sendFn();
      if (isThenable(result)) {
        Promise.resolve(result).catch(settleOnFailure);
      }
      return result;
    } catch (error) {
      settleOnFailure(error);
      throw error;
    }
  }, [conversationId]);

  return { wrapSend, pendingSendConversationId };
}

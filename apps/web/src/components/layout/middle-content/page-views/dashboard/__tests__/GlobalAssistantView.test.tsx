/**
 * GlobalAssistantView load-on-select regression tests
 *
 * Pure-function mirrors of the two load-on-select effects in
 * GlobalAssistantView.tsx (global-mode and agent-mode), following the same
 * extraction pattern used in SidebarChatTab.test.tsx — the component itself
 * is too hook-heavy to render cheaply in a unit test.
 *
 * Both effects previously fired unconditionally on a messages-reference
 * change (mount, reload, conversation/agent switch), which clobbers an
 * actively-streaming local Chat instance's messages with a stale snapshot
 * that predates the in-progress reply. This file pins the fix: both must
 * skip while this surface is actively streaming.
 */

import { describe, it, expect } from 'vitest';
import { resolveResumeAction } from '@/lib/ai/streams/resolveResumeAction';

/**
 * Mirrors the global-mode load-on-select effect (~line 1019-1044):
 * `if (selectedAgent) return; if (globalInitialMessages === prevRef) return; if (!globalIsInitialized || !globalConversationId || isOwnGlobalStreamForCurrentConversation) return; prevRef = globalInitialMessages; setGlobalLocalMessages(globalInitialMessages);`
 *
 * The prevRef/dedup check is load-bearing (CodeRabbit review on this PR): without it, this
 * effect re-fires on EVERY isOwnGlobalStreamForCurrentConversation transition, including the
 * streaming -> not-streaming edge at the end of an ordinary send. `globalInitialMessages` is not
 * refreshed for a fresh own completion (GlobalChatContext's onStreamComplete deliberately
 * no-ops for that case), so re-firing without the dedup would reapply the stale pre-send
 * snapshot and wipe the just-completed reply straight back out of the surface's own useChat
 * state.
 *
 * The guard is `isOwnGlobalStreamForCurrentConversation`, not the broader `effectiveIsStreaming`
 * (found via proactive review, not a reviewer comment) — see `isOwnStreamForConversation` below
 * for why the raw flag is wrong here.
 */
function shouldApplyGlobalLocalMessages<T>(
  selectedAgent: { id: string } | null,
  globalIsInitialized: boolean,
  globalConversationId: string | null,
  globalInitialMessages: T[],
  prevGlobalInitialMessages: T[] | null,
  isOwnGlobalStreamForCurrentConversation: boolean,
): boolean {
  if (selectedAgent) return false;
  if (globalInitialMessages === prevGlobalInitialMessages) return false;
  if (!globalIsInitialized || !globalConversationId || isOwnGlobalStreamForCurrentConversation) return false;
  return true;
}

/**
 * Mirrors the agent-mode load-signal effect (~line 993-1017):
 * `if (selectedAgent && agentConversationId && !isOwnAgentStreamForCurrentConversation) setAgentMessages(...)`
 */
function shouldApplyAgentMessagesOnLoadSignal(
  selectedAgent: { id: string } | null,
  agentConversationId: string | null,
  isOwnAgentStreamForCurrentConversation: boolean,
): boolean {
  return Boolean(selectedAgent) && Boolean(agentConversationId) && !isOwnAgentStreamForCurrentConversation;
}

/**
 * Mirrors the refreshSignal effect (~line 758-772): remote events (reconnect,
 * cross-tab edit/delete) bump refreshSignal, and this surface reacts by
 * calling handlePullUpRefresh — but only in global mode, and (as of this PR)
 * only while this conversation isn't the one MY OWN stream is running against,
 * since handlePullUpRefresh overwrites local messages with no reconciliation
 * against an in-flight stream.
 */
function shouldHandlePullUpRefresh(
  selectedAgent: { id: string } | null,
  isInitialized: boolean,
  isOwnGlobalStreamForCurrentConversation: boolean,
): boolean {
  return !selectedAgent && isInitialized && !isOwnGlobalStreamForCurrentConversation;
}

/**
 * Mirrors `isOwnAgentStreamForCurrentConversation`/`isOwnGlobalStreamForCurrentConversation` in
 * GlobalAssistantView.tsx (identical shape to SidebarChatTab.tsx's `isOwnStreamForConversation`,
 * see that file for the full rationale): whether MY OWN local Chat is producing live content for
 * the conversation about to be loaded/refreshed. `agentStatus`/`globalStatus` belong to a
 * stable-id useChat instance that keeps reporting streaming across a conversation switch, for
 * the OLD conversation's still-in-flight request — comparing against the held stream-start id
 * (streamConvIdRef/globalStreamConvIdRef) is the only way to tell whether a currently-true
 * streaming flag actually belongs to the conversation now being loaded.
 */
function isOwnStreamForConversation(
  isStreamingNow: boolean,
  heldStreamConvId: string | null,
  targetConversationId: string | null,
): boolean {
  return isStreamingNow && heldStreamConvId === targetConversationId;
}

/**
 * Stateful simulator for the "ref-advances-only-on-apply" discipline — see
 * the identical helper and rationale in SidebarChatTab.test.tsx. Both the
 * agent load-signal effect and the refreshSignal effect in this file use a
 * "seen" ref alongside a streaming guard; a Codex review on this PR found the
 * first version advanced the ref before checking the guard, permanently
 * losing a load skipped mid-stream.
 */
function createRefAdvancesOnlyOnApplySimulator<X>() {
  let prevRef: X | null = null;
  return {
    step(x: X, guardPasses: boolean): boolean {
      if (x === prevRef) return false;
      if (!guardPasses) return false;
      prevRef = x;
      return true;
    },
  };
}

/**
 * Mirrors `resumeEnabled` — the `enabled` gate passed to useAppStateRecovery.
 *
 * Deliberately takes NO streaming argument. The gate must be a callback (evaluated at
 * fire time, on resume) and must gate on user-editing only. See the regression test below.
 */
function resumeEnabled(currentConversationId: string | null, isAnyEditing: boolean): boolean {
  return currentConversationId !== null && !isAnyEditing;
}

/**
 * Mirrors the side effects of the `onResume` body, in order. The decision itself is NOT
 * mirrored — it calls the real `resolveResumeAction`, so this pins the wiring (which stop,
 * which rejoin, and that the DB refresh runs last) against the real policy.
 */
type ResumeEffect = 'stop' | 'rejoin-agent' | 'rejoin-global' | 'refresh';

function planResume({
  native,
  isStreaming,
  selectedAgent,
}: {
  native: boolean;
  isStreaming: boolean;
  selectedAgent: { id: string } | null;
}): ResumeEffect[] {
  const action = resolveResumeAction({ native, isStreaming });
  if (action === 'noop') return [];
  const effects: ResumeEffect[] = [];
  if (action === 'rejoin-and-refresh') {
    // rawStop is local-only — it clears useChat state so the rejoin attaches cleanly.
    // It does NOT signal the server; the run keeps generating and is rejoined below.
    effects.push('stop', selectedAgent ? 'rejoin-agent' : 'rejoin-global');
  }
  effects.push('refresh');
  return effects;
}

const mockAgent = { id: 'agent-123' };
const mockPreSendSnapshot = [{ id: 'msg-1', role: 'user', content: 'Hello' }] as never[];
const mockPostLoadSnapshot = [
  { id: 'msg-1', role: 'user', content: 'Hello' },
  { id: 'msg-2', role: 'assistant', content: 'Hi there' },
] as never[];

describe('GlobalAssistantView load-on-select effects', () => {
  describe('shouldApplyGlobalLocalMessages (global mode)', () => {
    it('given global mode, initialized, with a conversation id, a new snapshot, and not streaming, should apply', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, true, 'conv-1', mockPostLoadSnapshot, null, false)
      ).toBe(true);
    });

    it('given agent selected, should never apply (agent mode owns its own effect)', () => {
      expect(
        shouldApplyGlobalLocalMessages(mockAgent, true, 'conv-1', mockPostLoadSnapshot, null, false)
      ).toBe(false);
    });

    it('given not yet initialized, should NOT apply', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, false, 'conv-1', mockPostLoadSnapshot, null, false)
      ).toBe(false);
    });

    it('given no conversation id, should NOT apply', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, true, null, mockPostLoadSnapshot, null, false)
      ).toBe(false);
    });

    it('given the snapshot reference is unchanged, should NOT re-apply (no-op)', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, true, 'conv-1', mockPostLoadSnapshot, mockPostLoadSnapshot, false)
      ).toBe(false);
    });

    // Regression coverage for the clobber bug fixed in this PR.
    it('given effectiveIsStreaming=true (e.g. reload/switch mid-stream), should NOT apply', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, true, 'conv-1', mockPostLoadSnapshot, null, true)
      ).toBe(false);
    });

    // Regression coverage for the CodeRabbit-flagged bug: without the prevRef dedup, this
    // effect re-fires on every effectiveIsStreaming transition — including the moment an
    // ordinary send finishes — and `globalInitialMessages` is never refreshed for that case
    // (GlobalChatContext's onStreamComplete deliberately no-ops for an own fresh stream), so it
    // would reapply the stale PRE-SEND snapshot and wipe the just-completed reply straight back
    // out of the surface's own useChat state. The already-applied snapshot (prevRef === current
    // reference) must short-circuit at the dedup check regardless of how the streaming flag
    // transitions around it.
    it('given the snapshot was already applied and effectiveIsStreaming flips from true to false (stream just completed), should NOT re-apply the stale pre-send snapshot', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, true, 'conv-1', mockPreSendSnapshot, mockPreSendSnapshot, true)
      ).toBe(false);
      expect(
        shouldApplyGlobalLocalMessages(null, true, 'conv-1', mockPreSendSnapshot, mockPreSendSnapshot, false)
      ).toBe(false);
    });
  });

  describe('shouldApplyAgentMessagesOnLoadSignal (agent mode)', () => {
    it('given an agent selected, a conversation id, and not streaming, should apply', () => {
      expect(shouldApplyAgentMessagesOnLoadSignal(mockAgent, 'conv-1', false)).toBe(true);
    });

    it('given global mode (no agent selected), should NOT apply', () => {
      expect(shouldApplyAgentMessagesOnLoadSignal(null, 'conv-1', false)).toBe(false);
    });

    it('given no agent conversation id yet, should NOT apply', () => {
      expect(shouldApplyAgentMessagesOnLoadSignal(mockAgent, null, false)).toBe(false);
    });

    // Regression coverage: the load-signal indirection avoids re-firing on every streamed
    // token, but still fires unconditionally on a fresh mount — a reload mid-stream must
    // still be guarded, or it clobbers the in-progress bubble with the pre-reply snapshot.
    it('given effectiveIsStreaming=true (e.g. reload mid-stream), should NOT apply', () => {
      expect(shouldApplyAgentMessagesOnLoadSignal(mockAgent, 'conv-1', true)).toBe(false);
    });
  });

  describe('shouldHandlePullUpRefresh (refreshSignal effect)', () => {
    it('given global mode, initialized, and not streaming, should refresh', () => {
      expect(shouldHandlePullUpRefresh(null, true, false)).toBe(true);
    });

    it('given agent mode, should NOT refresh (agent mode has its own multiplayer wiring)', () => {
      expect(shouldHandlePullUpRefresh(mockAgent, true, false)).toBe(false);
    });

    it('given not yet initialized, should NOT refresh', () => {
      expect(shouldHandlePullUpRefresh(null, false, false)).toBe(false);
    });

    // Regression coverage: this effect previously had NO streaming guard at all (a gap
    // missed in the first version of this PR) — handlePullUpRefresh overwrites local
    // messages unconditionally, so running it mid-stream clobbers the in-progress reply.
    it('given effectiveIsStreaming=true, should NOT refresh (would clobber the live reply)', () => {
      expect(shouldHandlePullUpRefresh(null, true, true)).toBe(false);
    });
  });

  // ============================================
  // Ref-advances-only-on-apply regression tests (Codex review on PR #2061)
  //
  // Pins the multi-render sequence the single-call boolean tests above can't
  // express: a load/refresh skipped while streaming must be retried once
  // streaming ends, even though the underlying reference/signal never
  // changed again in the meantime. Applies identically to the agent
  // load-signal effect (~972) and the refreshSignal effect (~745) in this
  // file — both use a "seen" ref alongside the streaming guard.
  // ============================================

  describe('ref-advances-only-on-apply (retry-after-guard-lifts)', () => {
    it('given the guard blocks (streaming) then later passes with the SAME reference, should apply on the later render instead of being lost', () => {
      const sim = createRefAdvancesOnlyOnApplySimulator<number>();
      const signal = 1;
      expect(sim.step(signal, false)).toBe(false); // streaming — blocked
      expect(sim.step(signal, true)).toBe(true); // streaming ended, same signal — must still apply
    });

    it('given the guard passes immediately, should apply once and not re-apply on a redundant re-render with the same reference', () => {
      const sim = createRefAdvancesOnlyOnApplySimulator<number>();
      const signal = 1;
      expect(sim.step(signal, true)).toBe(true);
      expect(sim.step(signal, true)).toBe(false); // already applied — no-op
    });

    it('given a NEW signal arrives while still blocked, should keep deferring until the guard passes, then apply the latest', () => {
      const sim = createRefAdvancesOnlyOnApplySimulator<number>();
      expect(sim.step(1, false)).toBe(false); // streaming — blocked
      expect(sim.step(2, false)).toBe(false); // still streaming — newer signal also deferred
      expect(sim.step(2, true)).toBe(true); // guard lifts — applies the latest signal
    });
  });

  // ============================================
  // isOwnStreamForConversation regression tests
  //
  // Found via proactive review, not a reviewer comment: the load-on-select/refresh effects
  // originally guarded on the raw effectiveIsStreaming flag, which reflects a stable-id useChat
  // instance that keeps reporting "streaming" across a conversation/agent switch — for the OLD
  // conversation's still-in-flight request, not the one now being loaded. Switching
  // conversations mid-stream does not abort the running POST (documented at length elsewhere in
  // this file, e.g. the streamConvIdRef/globalStreamConvIdRef comments). Guarding on the raw
  // flag would strand a newly-selected, idle conversation behind an unrelated stream still
  // running in a conversation the user already left, until that unrelated stream finished.
  // ============================================

  describe('isOwnStreamForConversation (conversation-scoped streaming guard)', () => {
    it('given streaming and the held stream conversation matches the target, should report true (blocks — this IS the conversation being clobbered)', () => {
      expect(isOwnStreamForConversation(true, 'conv-A', 'conv-A')).toBe(true);
    });

    it('given streaming but the held stream conversation is a DIFFERENT one than the target, should report false (does not block)', () => {
      expect(isOwnStreamForConversation(true, 'conv-A', 'conv-B')).toBe(false);
    });

    it('given not streaming at all, should report false regardless of conversation ids', () => {
      expect(isOwnStreamForConversation(false, 'conv-A', 'conv-A')).toBe(false);
    });

    it('given the exact regression scenario — sending in conv-A (or agent conversation A), then switching to idle conv-B while A keeps streaming — the load-on-select guard for conv-B must NOT be blocked', () => {
      const blocked = isOwnStreamForConversation(true, 'conv-A', 'conv-B');
      expect(blocked).toBe(false);
    });
  });

  describe('app-state resume recovery (useAppStateRecovery wiring)', () => {
    describe('resumeEnabled (the gate)', () => {
      it('given a conversation and no active editing, should enable recovery', () => {
        expect(resumeEnabled('conv-A', false)).toBe(true);
      });

      it('given no conversation, should NOT enable recovery (nothing to rejoin)', () => {
        expect(resumeEnabled(null, false)).toBe(false);
      });

      it('given the user is actively editing, should NOT enable recovery (would clobber their edit)', () => {
        expect(resumeEnabled('conv-A', true)).toBe(false);
      });

      it('given a stream is in flight, should STILL enable recovery — streaming is not an input to the gate', () => {
        // THE REGRESSION. The gate used to be a render-time boolean that folded in
        // `!isStreaming`. iOS freezes JS the moment the app backgrounds, so the value
        // that gated the resume was whatever was true when the app went away — i.e.
        // streaming — which disabled recovery in exactly the case it was written for.
        // The gate takes no streaming argument at all now; there is no way to express
        // that bug in this signature. The streaming decision belongs to
        // resolveResumeAction, at fire time.
        expect(resumeEnabled('conv-A', false)).toBe(true);
      });
    });

    describe('planResume (the onResume body)', () => {
      it('given native mid-stream (the orphaned-stream bug), should stop the local fetch, rejoin the global stream, then refresh', () => {
        expect(planResume({ native: true, isStreaming: true, selectedAgent: null })).toEqual([
          'stop',
          'rejoin-global',
          'refresh',
        ]);
      });

      it('given native mid-stream with an agent selected, should rejoin the AGENT stream', () => {
        expect(planResume({ native: true, isStreaming: true, selectedAgent: { id: 'agent-1' } })).toEqual([
          'stop',
          'rejoin-agent',
          'refresh',
        ]);
      });

      it('given native and NOT streaming, should still rejoin — the recovery is deterministic, not flag-gated', () => {
        // The local fetch is dead after backgrounding regardless of what useChat still
        // reports, so native always rejoins. /active-streams is the authoritative answer
        // on whether a stream is actually live; no client flag gates the rejoin.
        expect(planResume({ native: false, isStreaming: false, selectedAgent: null })).toEqual(['refresh']);
        expect(planResume({ native: true, isStreaming: false, selectedAgent: null })).toEqual([
          'stop',
          'rejoin-global',
          'refresh',
        ]);
      });

      it('given web with a live fetch, should do nothing — the fetch survives a tab switch and must not be clobbered', () => {
        expect(planResume({ native: false, isStreaming: true, selectedAgent: null })).toEqual([]);
      });

      it('given web with no live fetch, should refresh only (no stop, no rejoin)', () => {
        expect(planResume({ native: false, isStreaming: false, selectedAgent: { id: 'agent-1' } })).toEqual([
          'refresh',
        ]);
      });
    });
  });
});

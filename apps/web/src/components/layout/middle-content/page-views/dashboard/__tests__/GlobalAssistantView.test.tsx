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

/**
 * Mirrors the global-mode load-on-select effect (~line 983-991):
 * `if (selectedAgent) return; if (!globalIsInitialized || !globalConversationId || effectiveIsStreaming) return; setGlobalLocalMessages(globalInitialMessages);`
 */
function shouldApplyGlobalLocalMessages(
  selectedAgent: { id: string } | null,
  globalIsInitialized: boolean,
  globalConversationId: string | null,
  effectiveIsStreaming: boolean,
): boolean {
  if (selectedAgent) return false;
  if (!globalIsInitialized || !globalConversationId || effectiveIsStreaming) return false;
  return true;
}

/**
 * Mirrors the agent-mode load-signal effect (~line 972-981):
 * `if (selectedAgent && agentConversationId && !effectiveIsStreaming) setAgentMessages(...)`
 */
function shouldApplyAgentMessagesOnLoadSignal(
  selectedAgent: { id: string } | null,
  agentConversationId: string | null,
  effectiveIsStreaming: boolean,
): boolean {
  return Boolean(selectedAgent) && Boolean(agentConversationId) && !effectiveIsStreaming;
}

/**
 * Mirrors the refreshSignal effect (~line 745-757): remote events (reconnect,
 * cross-tab edit/delete) bump refreshSignal, and this surface reacts by
 * calling handlePullUpRefresh — but only in global mode, and (as of this PR)
 * only while not actively streaming, since handlePullUpRefresh overwrites
 * local messages with no reconciliation against an in-flight stream.
 */
function shouldHandlePullUpRefresh(
  selectedAgent: { id: string } | null,
  isInitialized: boolean,
  effectiveIsStreaming: boolean,
): boolean {
  return !selectedAgent && isInitialized && !effectiveIsStreaming;
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

const mockAgent = { id: 'agent-123' };

describe('GlobalAssistantView load-on-select effects', () => {
  describe('shouldApplyGlobalLocalMessages (global mode)', () => {
    it('given global mode, initialized, with a conversation id, and not streaming, should apply', () => {
      expect(shouldApplyGlobalLocalMessages(null, true, 'conv-1', false)).toBe(true);
    });

    it('given agent selected, should never apply (agent mode owns its own effect)', () => {
      expect(shouldApplyGlobalLocalMessages(mockAgent, true, 'conv-1', false)).toBe(false);
    });

    it('given not yet initialized, should NOT apply', () => {
      expect(shouldApplyGlobalLocalMessages(null, false, 'conv-1', false)).toBe(false);
    });

    it('given no conversation id, should NOT apply', () => {
      expect(shouldApplyGlobalLocalMessages(null, true, null, false)).toBe(false);
    });

    // Regression coverage for the clobber bug fixed in this PR.
    it('given effectiveIsStreaming=true (e.g. reload/switch mid-stream), should NOT apply', () => {
      expect(shouldApplyGlobalLocalMessages(null, true, 'conv-1', true)).toBe(false);
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
});

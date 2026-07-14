/**
 * SidebarChatTab Tests
 * Tests for seamless message display and streaming state during navigation
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveResumeAction } from '@/lib/ai/streams/resolveResumeAction';

// ============================================
// Test Helpers - Display Logic Extraction
// ============================================

/**
 * Pure function that mirrors the displayMessages logic in SidebarChatTab
 * This allows us to test the logic in isolation without rendering the full component
 */
function getDisplayMessages<T>(
  selectedAgent: { id: string } | null,
  messages: T[],
  contextMessages: T[]
): T[] {
  return selectedAgent ? messages : contextMessages;
}

/**
 * Pure function that mirrors the displayIsStreaming logic in SidebarChatTab
 */
function getDisplayIsStreaming(
  selectedAgent: { id: string } | null,
  isStreaming: boolean,
  contextIsStreaming: boolean
): boolean {
  return selectedAgent ? isStreaming : (isStreaming || contextIsStreaming);
}

/**
 * Pure function that mirrors the handleStop logic in SidebarChatTab
 */
function getStopFunction(
  selectedAgent: { id: string } | null,
  contextStopStreaming: (() => void) | null,
  stop: () => void
): () => void {
  if (!selectedAgent && contextStopStreaming) {
    return contextStopStreaming;
  }
  return stop;
}

/**
 * Pure function that mirrors the agent-mode load-on-select effect in
 * SidebarChatTab: with a stable useChat id, the agent Chat instance is never
 * recreated on conversation switch, so usePageAgentSidebarState's fetched
 * messages must be explicitly applied via setMessages whenever the reference
 * changes — but only while in agent mode, and never while this surface is
 * actively streaming (a mount/reload/agent-switch landing mid-stream must not
 * clobber the in-progress assistant bubble with a stale conversation snapshot).
 */
function shouldApplySidebarAgentMessages<T>(
  selectedAgent: { id: string } | null,
  agentInitialMessages: T[],
  prevAgentInitialMessages: T[] | null,
  displayIsStreaming: boolean
): boolean {
  if (agentInitialMessages === prevAgentInitialMessages) return false;
  return Boolean(selectedAgent) && !displayIsStreaming;
}

/**
 * Pure function that mirrors the global-mode load-on-select effect in
 * SidebarChatTab: GlobalChatContext's `initialMessages` reference changes on
 * mount/loadConversation/createNewConversation, and must be explicitly
 * re-fetched via loadGlobalMessages — but never while this surface is
 * actively streaming, for the same clobber reason as the agent-mode twin.
 */
function shouldLoadSidebarGlobalMessages<T>(
  selectedAgent: { id: string } | null,
  globalIsInitialized: boolean,
  globalConversationId: string | null,
  globalInitialMessages: T[],
  prevGlobalInitialMessages: T[] | null,
  displayIsStreaming: boolean
): boolean {
  if (globalInitialMessages === prevGlobalInitialMessages) return false;
  return !selectedAgent && globalIsInitialized && Boolean(globalConversationId) && !displayIsStreaming;
}

/**
 * Stateful simulator for the "ref-advances-only-on-apply" discipline used by
 * every load-on-select / refreshSignal effect in this file (global
 * load-on-select, agent load-on-select, and the refreshSignal effect). A
 * CodeRabbit/Codex review on this PR found that the first version of these
 * fixes advanced the "seen" ref BEFORE checking the streaming guard: when the
 * guard blocked (streaming), the ref was still marked as seen, so once
 * streaming ended the effect would keep seeing "no change" on the same
 * reference and permanently skip the deferred load. This simulator mirrors
 * the corrected effect body across multiple renders so that retry-after-
 * guard-lifts behavior can be pinned directly, not just checked as a single
 * boolean call.
 */
function createRefAdvancesOnlyOnApplySimulator<X>() {
  let prevRef: X | null = null;
  return {
    /** Simulates one render/effect run. Returns true if the apply ran. */
    step(x: X, guardPasses: boolean): boolean {
      if (x === prevRef) return false;
      if (!guardPasses) return false;
      prevRef = x;
      return true;
    },
  };
}

/**
 * Mirrors `isOwnStreamForCurrentConversation` in SidebarChatTab.tsx: whether MY OWN local
 * useChat is producing live content for the conversation about to be loaded/refreshed.
 *
 * Found via proactive review (not a reviewer comment): the raw `isStreaming`/`displayIsStreaming`
 * flag belongs to a stable-id useChat instance that keeps reporting true across a conversation
 * switch, for the OLD conversation's still-in-flight request — switching conversations does not
 * abort it. Comparing against `heldStreamConvId` (latched to the conversation the stream actually
 * started in) is the only way to tell whether a currently-true streaming flag actually belongs to
 * the conversation now being loaded, or to one the user has already left.
 */
function isOwnStreamForConversation(
  isStreaming: boolean,
  heldStreamConvId: string | null,
  targetConversationId: string | null,
): boolean {
  return isStreaming && heldStreamConvId === targetConversationId;
}

/**
 * Mirrors `resumeEnabled` — the `enabled` gate passed to useAppStateRecovery.
 *
 * Deliberately takes NO streaming argument, which is the whole point. The gate used to be a
 * render-time boolean folding in `!isStreaming`; iOS freezes JS the moment the app backgrounds,
 * so the value that gated the resume was whatever was true when the app went away — streaming —
 * and recovery was disabled in exactly the case it was written for. The gate must be a callback
 * (evaluated at fire time) considering only the conversation and user-editing; the streaming
 * decision belongs to resolveResumeAction.
 */
function resumeEnabled(currentConversationId: string | null, isAnyEditing: boolean): boolean {
  return currentConversationId !== null && !isAnyEditing;
}

/**
 * Mirrors the side effects of the `onResume` body, IN ORDER. The decision itself is NOT
 * mirrored — it calls the real `resolveResumeAction`, so this pins the wiring against the
 * real policy.
 *
 * Two invariants worth stating plainly, because both were bugs:
 *
 *  - On the native path we stop the local fetch and hand off to `tryRecover`, and there is NO
 *    DB-refresh fallback afterwards. tryRecover already refetches when the run finished while
 *    we were away. A fallback would only fire in the cases where a DB write is UNSAFE: the
 *    /active-streams probe failed (a stream may still be live, and the DB cannot contain an
 *    unpersisted reply), or the DB is behind local state (a send whose POST never landed).
 *
 *  - The web path never stops or probes: a live fetch survives a tab switch.
 *
 */
type ResumeEffect = 'stop' | 'try-recover' | 'refresh' | 'regenerate';

function planResume({
  native,
  isStreaming,
  ownTurnInFlight = isStreaming,
  recovered = true,
  probeAnswered = true,
}: {
  native: boolean;
  /** The broad display/effective streaming flag — what resolveResumeAction sees. */
  isStreaming: boolean;
  /**
   * Whether a stream of OUR OWN was running for the conversation ON SCREEN. Distinct from
   * `isStreaming`, which stays true for a stream still running against a conversation the user has
   * since navigated away from (the useChat id is stable across a switch). Only this may gate a
   * regenerate — otherwise we would fire a generation for the turn the user is now LOOKING at
   * rather than the one that was interrupted.
   */
  ownTurnInFlight?: boolean;
  /** What tryRecover returned: it rejoined a live stream, or refetched a persisted reply. */
  recovered?: boolean;
  /** Whether the /active-streams probe actually reached the server and answered. */
  probeAnswered?: boolean;
}): ResumeEffect[] {
  const action = resolveResumeAction({ native, isStreaming });
  if (action === 'noop') return [];
  if (action === 'refresh') return ['refresh'];
  // The stop is local-only. It clears useChat state and — critically — ends the dead response
  // body, which releases the channel's `consuming` mark. Without that the rejoin's bootstrap
  // treats the stream as one we are already reading off the POST and skips attaching it.
  const effects: ResumeEffect[] = ['stop', 'try-recover'];
  if (recovered) return effects;
  // Nothing recovered. NOT a DB refresh (unsafe: it would erase an in-progress bubble or the
  // user's own prompt). Regenerate — but only on an ANSWERED probe, and only if a turn of ours was
  // really in flight for this conversation.
  if (ownTurnInFlight && probeAnswered) effects.push('regenerate');
  return effects;
}

// ============================================
// Test Data
// ============================================

const mockUserMessage = {
  id: 'msg-1',
  role: 'user',
  content: 'Hello',
};

const mockAssistantMessage = {
  id: 'msg-2',
  role: 'assistant',
  content: 'Hi there!',
};

const mockContextMessages = [
  { id: 'ctx-1', role: 'user', content: 'Context message' },
  { id: 'ctx-2', role: 'assistant', content: 'Context response' },
] as never[];

const mockAgentMessages = [mockUserMessage, mockAssistantMessage] as never[];

const mockAgent = { id: 'agent-123' };

// ============================================
// displayMessages Tests
// ============================================

describe('SidebarChatTab Display Logic', () => {
  describe('getDisplayMessages', () => {
    it('given global mode (no agent), should return context messages', () => {
      const result = getDisplayMessages(null, mockAgentMessages, mockContextMessages);
      expect(result).toBe(mockContextMessages);
      expect(result).toHaveLength(2);
      expect((result[0] as { id: string }).id).toBe('ctx-1');
    });

    it('given agent mode (agent selected), should return agent messages', () => {
      const result = getDisplayMessages(mockAgent, mockAgentMessages, mockContextMessages);
      expect(result).toBe(mockAgentMessages);
      expect(result).toHaveLength(2);
      expect((result[0] as { id: string }).id).toBe('msg-1');
    });

    it('given global mode with empty context messages, should return empty array', () => {
      const result = getDisplayMessages(null, mockAgentMessages, []);
      expect(result).toEqual([]);
    });

    it('given agent mode with empty agent messages, should return empty array', () => {
      const result = getDisplayMessages(mockAgent, [], mockContextMessages);
      expect(result).toEqual([]);
    });

    it('given transition from agent to global mode, should switch to context messages', () => {
      // First in agent mode
      let result = getDisplayMessages(mockAgent, mockAgentMessages, mockContextMessages);
      expect(result).toBe(mockAgentMessages);

      // Then switch to global mode
      result = getDisplayMessages(null, mockAgentMessages, mockContextMessages);
      expect(result).toBe(mockContextMessages);
    });
  });

  // ============================================
  // displayIsStreaming Tests
  // ============================================

  describe('getDisplayIsStreaming', () => {
    it('given global mode with context streaming, should return true', () => {
      const result = getDisplayIsStreaming(null, false, true);
      expect(result).toBe(true);
    });

    it('given global mode with local streaming, should return true', () => {
      const result = getDisplayIsStreaming(null, true, false);
      expect(result).toBe(true);
    });

    it('given global mode with both streaming, should return true', () => {
      const result = getDisplayIsStreaming(null, true, true);
      expect(result).toBe(true);
    });

    it('given global mode with neither streaming, should return false', () => {
      const result = getDisplayIsStreaming(null, false, false);
      expect(result).toBe(false);
    });

    it('given agent mode with local streaming, should return true', () => {
      const result = getDisplayIsStreaming(mockAgent, true, false);
      expect(result).toBe(true);
    });

    it('given agent mode without streaming, should return false even if context is streaming', () => {
      // Agent mode ignores context streaming state
      const result = getDisplayIsStreaming(mockAgent, false, true);
      expect(result).toBe(false);
    });

    it('given agent mode with local streaming, should return true regardless of context', () => {
      const result = getDisplayIsStreaming(mockAgent, true, true);
      expect(result).toBe(true);
    });
  });

  // ============================================
  // handleStop Logic Tests
  // ============================================

  describe('getStopFunction', () => {
    it('given global mode with context stop available, should return context stop', () => {
      const contextStop = vi.fn();
      const localStop = vi.fn();

      const stopFn = getStopFunction(null, contextStop, localStop);
      stopFn();

      expect(contextStop).toHaveBeenCalledTimes(1);
      expect(localStop).not.toHaveBeenCalled();
    });

    it('given global mode without context stop, should return local stop', () => {
      const localStop = vi.fn();

      const stopFn = getStopFunction(null, null, localStop);
      stopFn();

      expect(localStop).toHaveBeenCalledTimes(1);
    });

    it('given agent mode, should always return local stop', () => {
      const contextStop = vi.fn();
      const localStop = vi.fn();

      const stopFn = getStopFunction(mockAgent, contextStop, localStop);
      stopFn();

      expect(localStop).toHaveBeenCalledTimes(1);
      expect(contextStop).not.toHaveBeenCalled();
    });

    it('given agent mode without context stop, should return local stop', () => {
      const localStop = vi.fn();

      const stopFn = getStopFunction(mockAgent, null, localStop);
      stopFn();

      expect(localStop).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================
  // Navigation Transition Tests
  // ============================================

  describe('Navigation Transition Behavior', () => {
    it('given streaming in global mode and navigating to page, should preserve streaming visibility', () => {
      // Simulates: User starts streaming on dashboard, navigates to a page
      // The sidebar should show streaming state from context

      const isLocalStreaming = false; // Sidebar's local useChat not streaming
      const isContextStreaming = true; // GlobalAssistantView is streaming

      // After navigation, sidebar checks displayIsStreaming
      const displayIsStreaming = getDisplayIsStreaming(null, isLocalStreaming, isContextStreaming);
      expect(displayIsStreaming).toBe(true);
    });

    it('given messages in global mode and navigating to page, should show context messages', () => {
      // Simulates: User has messages in GlobalAssistantView, navigates to a page
      // The sidebar should show the same messages from context

      const localMessages: unknown[] = []; // Sidebar's local messages (may be empty/stale)
      const contextMessages = mockContextMessages; // Messages from GlobalChatContext

      const displayMessages = getDisplayMessages(null, localMessages, contextMessages);
      expect(displayMessages).toBe(contextMessages);
      expect(displayMessages).toHaveLength(2);
    });

    it('given agent streaming in dashboard and navigating to page, should show agent streaming', () => {
      // Simulates: User starts agent streaming on dashboard, navigates to a page
      // After transferFromDashboard, sidebar should show streaming from agent's useChat

      const isLocalStreaming = true; // After transfer, agent's useChat is streaming
      const isContextStreaming = false;

      const displayIsStreaming = getDisplayIsStreaming(mockAgent, isLocalStreaming, isContextStreaming);
      expect(displayIsStreaming).toBe(true);
    });

    it('given agent messages in dashboard and navigating to page, should show agent messages', () => {
      // Simulates: User has agent messages in dashboard, navigates to a page
      // After transferFromDashboard, sidebar should show agent messages

      const localMessages = mockAgentMessages; // Transferred from dashboard
      const contextMessages = mockContextMessages;

      const displayMessages = getDisplayMessages(mockAgent, localMessages, contextMessages);
      expect(displayMessages).toBe(mockAgentMessages);
      expect(displayMessages).toHaveLength(2);
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe('Edge Cases', () => {
    it('given undefined messages arrays, should handle gracefully', () => {
      // TypeScript prevents this, but test runtime behavior
      const result = getDisplayMessages(null, [], []);
      expect(result).toEqual([]);
    });

    it('given rapid mode switching, should return correct messages', () => {
      // Switch modes multiple times rapidly
      let result = getDisplayMessages(null, mockAgentMessages, mockContextMessages);
      expect(result).toBe(mockContextMessages);

      result = getDisplayMessages(mockAgent, mockAgentMessages, mockContextMessages);
      expect(result).toBe(mockAgentMessages);

      result = getDisplayMessages(null, mockAgentMessages, mockContextMessages);
      expect(result).toBe(mockContextMessages);

      result = getDisplayMessages(mockAgent, mockAgentMessages, mockContextMessages);
      expect(result).toBe(mockAgentMessages);
    });

    it('given concurrent streaming states, should handle correctly in global mode', () => {
      // Both local and context streaming (edge case during transition)
      const result = getDisplayIsStreaming(null, true, true);
      expect(result).toBe(true);
    });

    it('given many messages, should return reference efficiently', () => {
      const manyMessages = Array.from({ length: 1000 }, (_, i) => ({
        id: `msg-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      })) as never[];

      const result = getDisplayMessages(null, [], manyMessages);
      // Should return the same reference, not a copy
      expect(result).toBe(manyMessages);
    });
  });

  // ============================================
  // Agent-mode load-on-select regression tests
  //
  // Regression coverage for: with a stable useChat id, the sidebar's agent
  // Chat instance is never recreated on conversation switch/select/create, so
  // fetched messages must be explicitly applied via setMessages. Without this,
  // agent-mode conversations never load in the sidebar (the exact class of bug
  // this PR fixes, reintroduced for this one surface).
  // ============================================

  describe('shouldApplySidebarAgentMessages (agent-mode load-on-select)', () => {
    it('given an agent selected and a new messages reference, should apply', () => {
      expect(shouldApplySidebarAgentMessages(mockAgent, mockAgentMessages, null, false)).toBe(true);
    });

    it('given an agent selected and conversation switch fetches a new reference, should apply', () => {
      const firstConversation = [mockUserMessage] as never[];
      const secondConversation = [mockAssistantMessage] as never[];
      expect(shouldApplySidebarAgentMessages(mockAgent, secondConversation, firstConversation, false)).toBe(true);
    });

    it('given an agent selected but the messages reference is unchanged, should NOT re-apply (no-op)', () => {
      expect(shouldApplySidebarAgentMessages(mockAgent, mockAgentMessages, mockAgentMessages, false)).toBe(false);
    });

    it('given global mode (no agent selected), should never apply agent messages even on a new reference', () => {
      expect(shouldApplySidebarAgentMessages(null, mockAgentMessages, null, false)).toBe(false);
    });

    it('given a new empty-array reference (new conversation created), should still apply', () => {
      expect(shouldApplySidebarAgentMessages(mockAgent, [], null, false)).toBe(true);
    });

    // Regression coverage for the clobber bug fixed in this PR: a mount/reload/agent-switch
    // landing while this surface is actively streaming must NOT overwrite the in-progress
    // assistant bubble with a stale conversation snapshot, even though the messages
    // reference did change (this is exactly the condition a reload produces).
    it('given a new messages reference while streaming, should NOT apply (would clobber the live reply)', () => {
      expect(shouldApplySidebarAgentMessages(mockAgent, mockAgentMessages, null, true)).toBe(false);
    });

    it('given a conversation switch fetch lands mid-stream, should NOT apply', () => {
      const firstConversation = [mockUserMessage] as never[];
      const secondConversation = [mockAssistantMessage] as never[];
      expect(shouldApplySidebarAgentMessages(mockAgent, secondConversation, firstConversation, true)).toBe(false);
    });
  });

  // ============================================
  // Global-mode load-on-select regression tests
  //
  // Regression coverage for the same clobber bug as the agent-mode twin above,
  // but on the global-assistant path: GlobalChatContext's `initialMessages`
  // changes reference on mount/loadConversation/createNewConversation, and
  // SidebarChatTab re-fetches via loadGlobalMessages whenever it does — but
  // must skip that re-fetch while this surface is actively streaming, or a
  // reload/conversation-switch mid-stream clobbers the in-progress reply with
  // a DB snapshot that predates it (the flash + "invisible streaming" bug).
  // ============================================

  describe('shouldLoadSidebarGlobalMessages (global-mode load-on-select)', () => {
    it('given global mode, initialized, with a new messages reference, should load', () => {
      expect(
        shouldLoadSidebarGlobalMessages(null, true, 'conv-1', mockContextMessages, null, false)
      ).toBe(true);
    });

    it('given the messages reference is unchanged, should NOT re-load (no-op)', () => {
      expect(
        shouldLoadSidebarGlobalMessages(null, true, 'conv-1', mockContextMessages, mockContextMessages, false)
      ).toBe(false);
    });

    it('given agent mode (agent selected), should never load global messages', () => {
      expect(
        shouldLoadSidebarGlobalMessages(mockAgent, true, 'conv-1', mockContextMessages, null, false)
      ).toBe(false);
    });

    it('given not yet initialized, should NOT load', () => {
      expect(
        shouldLoadSidebarGlobalMessages(null, false, 'conv-1', mockContextMessages, null, false)
      ).toBe(false);
    });

    it('given no conversation id, should NOT load', () => {
      expect(
        shouldLoadSidebarGlobalMessages(null, true, null, mockContextMessages, null, false)
      ).toBe(false);
    });

    it('given a new messages reference while streaming (e.g. reload mid-stream), should NOT load (would clobber the live reply)', () => {
      expect(
        shouldLoadSidebarGlobalMessages(null, true, 'conv-1', mockContextMessages, null, true)
      ).toBe(false);
    });

    it('given a conversation switch lands mid-stream, should NOT load', () => {
      const firstConversation = [mockUserMessage] as never[];
      const secondConversation = [mockAssistantMessage] as never[];
      expect(
        shouldLoadSidebarGlobalMessages(null, true, 'conv-1', secondConversation, firstConversation, true)
      ).toBe(false);
    });
  });

  // ============================================
  // Ref-advances-only-on-apply regression tests (Codex review on PR #2061)
  //
  // Pins the multi-render sequence the single-call boolean tests above can't
  // express: a load skipped while streaming must be retried once streaming
  // ends, even though the underlying reference never changed again in the
  // meantime. This is the actual defect class flagged in review — the fix is
  // "only advance the ref when the apply runs," applied identically to the
  // global load-on-select effect (~747), the agent load-on-select effect
  // (~765), and the pre-existing refreshSignal effect (~612) in this file.
  // ============================================

  describe('ref-advances-only-on-apply (retry-after-guard-lifts)', () => {
    it('given the guard blocks (streaming) then later passes with the SAME reference, should apply on the later render instead of being lost', () => {
      const sim = createRefAdvancesOnlyOnApplySimulator<string[]>();
      const snapshot = ['a'];
      expect(sim.step(snapshot, false)).toBe(false); // streaming — blocked
      expect(sim.step(snapshot, true)).toBe(true); // streaming ended, same reference — must still apply
    });

    it('given the guard passes immediately, should apply once and not re-apply on a redundant re-render with the same reference', () => {
      const sim = createRefAdvancesOnlyOnApplySimulator<string[]>();
      const snapshot = ['a'];
      expect(sim.step(snapshot, true)).toBe(true);
      expect(sim.step(snapshot, true)).toBe(false); // already applied — no-op
    });

    it('given a NEW reference arrives while still blocked, should keep deferring until the guard passes, then apply the latest', () => {
      const sim = createRefAdvancesOnlyOnApplySimulator<string[]>();
      const first = ['a'];
      const second = ['b'];
      expect(sim.step(first, false)).toBe(false); // streaming — blocked
      expect(sim.step(second, false)).toBe(false); // still streaming — newer snapshot also deferred
      expect(sim.step(second, true)).toBe(true); // guard lifts — applies the latest snapshot
    });
  });

  // ============================================
  // isOwnStreamForConversation regression tests
  //
  // Found via proactive review, not a reviewer comment: the load-on-select/refresh effects
  // originally guarded on the raw `displayIsStreaming` flag, which reflects a stable-id useChat
  // instance that keeps reporting "streaming" across a conversation switch — for the OLD
  // conversation's still-in-flight request, not the one now being loaded. Switching
  // conversations does not abort an in-flight send (documented at length in both this file and
  // GlobalAssistantView.tsx). Guarding on the raw flag would strand a newly-selected, idle
  // conversation behind an unrelated stream still running in a conversation the user already
  // left, until that unrelated stream happened to finish.
  // ============================================

  describe('isOwnStreamForConversation (conversation-scoped streaming guard)', () => {
    it('given streaming and the held stream conversation matches the target, should report true (blocks the load — correct, this IS the conversation being clobbered)', () => {
      expect(isOwnStreamForConversation(true, 'conv-A', 'conv-A')).toBe(true);
    });

    it('given streaming but the held stream conversation is a DIFFERENT one than the target, should report false (does not block — the target conversation has no stream of its own)', () => {
      expect(isOwnStreamForConversation(true, 'conv-A', 'conv-B')).toBe(false);
    });

    it('given not streaming at all, should report false regardless of conversation ids', () => {
      expect(isOwnStreamForConversation(false, 'conv-A', 'conv-A')).toBe(false);
    });

    it('given no stream has ever started (held id is null) and not streaming, should report false', () => {
      expect(isOwnStreamForConversation(false, null, 'conv-A')).toBe(false);
    });

    it('given the exact regression scenario — send in conv-A, switch to idle conv-B while A keeps streaming — the load-on-select guard for conv-B must NOT be blocked', () => {
      // isStreaming stays true (stable useChat id survives the switch); heldStreamConvId is
      // latched to 'conv-A' (where the stream actually started); the surface has moved to 'conv-B'.
      const blocked = isOwnStreamForConversation(true, 'conv-A', 'conv-B');
      expect(blocked).toBe(false);
    });
  });

/**
 * Mirrors the rejoin branch of `tryRecover`: the live stream's messageId is used to evict the
 * half-streamed assistant bubble useChat is still holding, so the rejoined pending stream is not
 * deduped away.
 *
 * `Chat.stop()` "keeps the generated tokens", and a dropped fetch leaves them too — so `messages`
 * still holds an assistant message whose id IS the live stream's messageId (the server mints one
 * id and uses it for BOTH the UI message and the stream registry row). The rejoin re-adds that
 * same stream to the pending store, and the surfaces drop a pending stream whose messageId
 * already appears in `messages` (dedupRemoteStreams / ChatMessagesArea.visibleRemoteStreams).
 * Leave the stale bubble in place and the rejoined stream is filtered straight back out — not one
 * token renders, and the user stares at a frozen partial.
 */
function evictStalePartial<T extends { id: string }>(
  messages: T[],
  liveMessageId: string,
  serverPartsCount: number,
): T[] {
  // Only when the server has something to put in its place. `parts` from /active-streams is the
  // registry's DEBOUNCED checkpoint, so it is empty for a stream only a few parts old. Evicting
  // against an empty checkpoint and then failing the SSE join (the multi-instance case, where the
  // multicast lives in another process) removes the stream and leaves the user with NOTHING —
  // strictly worse than the frozen partial we started with.
  if (serverPartsCount === 0) return messages;
  return messages.filter((m) => m.id !== liveMessageId);
}

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

    });

    describe('planResume (the onResume body)', () => {
      it('given native mid-stream (the orphaned-stream bug), should stop the local fetch and hand off to tryRecover — and NOT read the DB', () => {
        // THE KEY INVARIANT. The reply is not persisted until the run completes, so a DB
        // snapshot taken while the stream is still generating contains no assistant message.
        // Writing it would wipe the in-progress bubble. tryRecover asks /active-streams first
        // and rejoins; the DB is never read while a run is live.
        expect(planResume({ native: true, isStreaming: true })).toEqual(['stop', 'try-recover']);
      });

      it('given native, should always stop BEFORE recovering', () => {
        // The stop is local-only, but it is what ends the dead response body and so releases
        // the channel's `consuming` mark. Without that, the rejoin's bootstrap classifies the
        // stream as one we are already reading off the POST body and skips attaching it — the
        // rejoin would silently do nothing.
        const plan = planResume({ native: true, isStreaming: true });
        expect(plan.indexOf('stop')).toBeLessThan(plan.indexOf('try-recover'));
      });

      it('given native and NOT streaming, should still stop and probe — the recovery is deterministic, not flag-gated', () => {
        // The local fetch is dead after backgrounding regardless of what useChat still
        // reports, so native always probes. /active-streams is the authoritative answer
        // on whether a stream is actually live; no client flag gates the rejoin.
        expect(planResume({ native: true, isStreaming: false })).toEqual(['stop', 'try-recover']);
      });

      it('given web with a live fetch, should do nothing — the fetch survives a tab switch and must not be clobbered', () => {
        expect(planResume({ native: false, isStreaming: true })).toEqual([]);
      });

      it('given web with no live fetch, should refresh only (no stop, no probe)', () => {
        expect(planResume({ native: false, isStreaming: false })).toEqual(['refresh']);
      });

      it('given native, a stream for a DIFFERENT conversation, and nothing to recover, should NOT regenerate', () => {
        // The broad flag stays true for a stream still running against a conversation the user has
        // navigated away from. Regenerating on it would fire a generation for the turn now on
        // screen rather than the interrupted one — a spurious reply, and a spurious charge, on an
        // untouched conversation.
        expect(
          planResume({ native: true, isStreaming: true, ownTurnInFlight: false, recovered: false }),
        ).toEqual(['stop', 'try-recover']);
      });

      it('given native and the probe never ANSWERED, should NOT regenerate', () => {
        // Silence is not an answer. Every generation start calls takeOverConversationStreams, so a
        // regenerate issued while the run is in fact still live does not race it — it ABORTS it.
        // We would kill a healthy generation, re-run write tools it had already executed, bill the
        // discarded tokens, and strand its partial in the DB. Doing nothing is safe: the stop
        // released the `consuming` mark, so the socket-reconnect bootstrap picks a live run up.
        expect(
          planResume({
            native: true,
            isStreaming: true,
            ownTurnInFlight: true,
            recovered: false,
            probeAnswered: false,
          }),
        ).toEqual(['stop', 'try-recover']);
      });

      it('given native, a turn in flight, an ANSWERED probe, and NOTHING to recover, should regenerate — never a DB refresh', () => {
        // The stop above settles useChat at `ready` with no `error`, and useStreamRecovery only
        // fires on `status === 'error'` — so aborting the fetch destroys the very signal that
        // used to drive the fallback. Without regenerating here, a turn whose POST died on the
        // background transition (a radio drop right then is common) finds no stream, no reply and
        // no error, and the user's prompt sits unanswered forever.
        const plan = planResume({ native: true, isStreaming: true, recovered: false });
        expect(plan).toEqual(['stop', 'try-recover', 'regenerate']);
        expect(plan).not.toContain('refresh');
      });

      it('given native, NO turn in flight, and nothing to recover, should NOT regenerate', () => {
        // An ordinary resume on an idle conversation must never fire a spurious generation.
        expect(planResume({ native: true, isStreaming: false, recovered: false })).toEqual([
          'stop',
          'try-recover',
        ]);
      });
    });

    describe('evictStalePartial (why the rejoin renders at all)', () => {
      const liveId = 'srv-msg-1';
      const messages = [
        { id: 'u1', role: 'user' },
        { id: liveId, role: 'assistant' }, // the frozen half-streamed bubble
      ];

      it('given a rejoined live stream the server has parts for, should drop the local partial carrying that same messageId', () => {
        // Without this the pending stream the rejoin adds under `liveId` is deduped away,
        // because `liveId` is still present in `messages`. The bubble would never update.
        expect(evictStalePartial(messages, liveId, 12)).toEqual([{ id: 'u1', role: 'user' }]);
      });

      it('given the partial is evicted, the rejoined stream is no longer deduped out', () => {
        const remaining = evictStalePartial(messages, liveId, 12);
        const seen = new Set(remaining.map((m) => m.id));
        expect(seen.has(liveId)).toBe(false);
      });

      it('given the server checkpoint is EMPTY, should KEEP the local partial', () => {
        // The debounced checkpoint is empty for a stream only a few parts old. If we evicted here
        // and the SSE join then failed (multi-instance: the multicast lives in another process),
        // the bootstrap removes the stream and the user is left with nothing at all — worse than
        // the frozen partial. Keep what they had; the rejoin can still attach and take over.
        expect(evictStalePartial(messages, liveId, 0)).toEqual(messages);
      });

      it('given messages with no matching id, should leave them untouched', () => {
        expect(evictStalePartial(messages, 'some-other-id', 12)).toEqual(messages);
      });

      it('should only ever drop the ONE message the server named — never the user turn', () => {
        const out = evictStalePartial(messages, liveId, 12);
        expect(out.some((m) => m.role === 'user')).toBe(true);
      });
    });
  });
});

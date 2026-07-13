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
});

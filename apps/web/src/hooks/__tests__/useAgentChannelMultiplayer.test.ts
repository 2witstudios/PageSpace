import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { UseChannelStreamSocketOptions } from '@/hooks/useChannelStreamSocket';

// ---------------------------------------------------------------------------
// Hoisted state captured from the dependency hooks under test
// ---------------------------------------------------------------------------
const {
  capturedChannel,
  mockUseChannelStreamSocket,
  mockUsePageSocketRoom,
  mockUseStreamingRegistration,
  mockAbortByMessageId,
  mockSocketStatus,
  pendingStreams,
} = vi.hoisted(() => {
  const ref: { channelId: string | undefined; options: UseChannelStreamSocketOptions | undefined } = {
    channelId: undefined,
    options: undefined,
  };
  return {
    capturedChannel: ref,
    mockUseChannelStreamSocket: vi.fn(),
    mockUsePageSocketRoom: vi.fn(),
    mockUseStreamingRegistration: vi.fn(),
    mockAbortByMessageId: vi.fn(),
    mockSocketStatus: { current: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error' },
    pendingStreams: { current: new Map<string, { messageId: string; pageId: string; conversationId: string; triggeredBy: { userId: string; displayName: string }; parts: UIMessage['parts']; isOwn: boolean }>() },
  };
});

vi.mock('@/hooks/useChannelStreamSocket', () => ({
  useChannelStreamSocket: (channelId: string | undefined, options?: UseChannelStreamSocketOptions) => {
    capturedChannel.channelId = channelId;
    capturedChannel.options = options;
    mockUseChannelStreamSocket(channelId, options);
    return { rejoinActiveStreams: vi.fn() };
  },
}));

vi.mock('@/hooks/usePageSocketRoom', () => ({
  usePageSocketRoom: mockUsePageSocketRoom,
}));

vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: vi.fn((selector: (s: { connectionStatus: string }) => unknown) =>
    selector({ connectionStatus: mockSocketStatus.current }),
  ),
}));

vi.mock('@/stores/usePendingStreamsStore', () => ({
  usePendingStreamsStore: Object.assign(vi.fn(() => []), {
    getState: vi.fn(() => ({ streams: pendingStreams.current })),
  }),
}));

vi.mock('@/lib/ai/shared', () => ({
  useStreamingRegistration: mockUseStreamingRegistration,
}));

vi.mock('@/lib/ai/core/stream-abort-client', () => ({
  abortActiveStreamByMessageId: mockAbortByMessageId,
}));

// Real Zustand store imported AFTER mocks
import { usePageAgentDashboardStore, selectIsAgentStreaming, selectAgentStop } from '@/stores/page-agents';
import { useAgentChannelMultiplayer } from '../useAgentChannelMultiplayer';

const CONV_ID = 'conv-1';
const AGENT = { id: 'agent-1' };

type StopSlot = { agentId: string; stop: () => void | Promise<void> } | null;

/** Seed the (agent-keyed) store the way production writes it. */
const seedDashboard = (overrides: Partial<{ agentStopStreaming: StopSlot; isAgentStreaming: boolean }> = {}) => {
  const slot = overrides.agentStopStreaming ?? null;
  usePageAgentDashboardStore.setState({
    streamingAgentIds: overrides.isAgentStreaming ? { [key(AGENT.id, CONV_ID)]: true } : {},
    agentStops: slot ? { [key(slot.agentId, CONV_ID)]: slot.stop } : {},
  });
};

// Read the slot through the PRODUCTION selectors, not a reimplementation of them — the
// whole bug was that a reader could get an un-scoped answer, so a test that does its own
// agent comparison would prove nothing about the code that ships.
const dashIsStreaming = (agentId: string = AGENT.id, conversationId: string = CONV_ID) =>
  selectIsAgentStreaming({ agentId, conversationId })(usePageAgentDashboardStore.getState());
const dashStop = (agentId: string = AGENT.id, conversationId: string = CONV_ID) =>
  selectAgentStop({ agentId, conversationId })(usePageAgentDashboardStore.getState());

/** Store key, the way production builds it. */
const key = (agentId: string, conversationId: string) => `${agentId}::${conversationId}`;

const baseOptions = (
  overrides: Partial<Parameters<typeof useAgentChannelMultiplayer>[0]>,
): Parameters<typeof useAgentChannelMultiplayer>[0] => ({
  selectedAgent: null,
  agentConversationId: null,
  setLocalMessages: vi.fn(),
  isLocallyStreaming: false,
  surfaceComponentName: 'TestSurface',
  loadConversation: vi.fn(),
  ...overrides,
});

const renderWiring = (
  options: Parameters<typeof useAgentChannelMultiplayer>[0],
) => renderHook(({ opts }) => useAgentChannelMultiplayer(opts), {
  initialProps: { opts: options },
});

describe('useAgentChannelMultiplayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedChannel.channelId = undefined;
    capturedChannel.options = undefined;
    mockSocketStatus.current = 'disconnected';
    pendingStreams.current = new Map();
    seedDashboard({ agentStopStreaming: null, isAgentStreaming: false });
  });

  describe('subscription', () => {
    it('given a selected agent, the channel-stream socket should be subscribed to the agent id', () => {
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      expect(capturedChannel.channelId).toBe(AGENT.id);
    });

    it('given selectedAgent is null, the channel-stream socket should be subscribed to undefined (no-op)', () => {
      renderWiring(baseOptions({}));

      expect(capturedChannel.channelId).toBeUndefined();
    });
  });

  describe('own-stream slot ownership', () => {
    // A channel can carry two of this user's own streams at once (send, then New Chat
    // while it runs), and only one holds the Stop slot. A bare boolean let the OTHER
    // one's finalize release the slot out from under the stream that actually owns it —
    // killing a live Stop button. The conversation guard makes this MORE reachable: a
    // declined stream is still registered for finalization.
    it('given a DIFFERENT own stream finalizes, the slot claimed by another stream should survive', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-claimer', conversationId: CONV_ID });
      });
      expect(dashIsStreaming()).toBe(true);

      // A second own stream on the channel finishes — it never claimed the slot.
      act(() => {
        capturedChannel.options?.onOwnStreamFinalize?.({ messageId: 'msg-someone-else' });
      });

      expect(dashIsStreaming()).toBe(true);
      expect(dashStop()).not.toBeNull();
    });

    // The claim is only ever released by onOwnStreamFinalize — and there are paths where
    // that event CANNOT fire: the socket effect tears down without finalizing on a
    // socket-instance swap (an auth:refreshed reconnect builds a brand-new io()), and if
    // the stream ended during that gap nothing is left to announce it. The flag would
    // strand true: a Stop button over a dead stream, plus permanent SWR suppression via
    // useStreamingRegistration. Bootstrap is the server's word on what is still running.
    it('given a claimed stream is absent from the next active-streams snapshot, the claim should be released', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-gone', conversationId: CONV_ID });
      });
      expect(dashIsStreaming()).toBe(true);

      // The next bootstrap says that stream is no longer running.
      act(() => {
        capturedChannel.options?.onActiveStreamsSnapshot?.(new Set<string>());
      });

      expect(dashIsStreaming()).toBe(false);
      expect(dashStop()).toBeNull();
    });

    it('given the claimed stream is STILL in the snapshot, the claim should survive', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-live', conversationId: CONV_ID });
      });

      act(() => {
        capturedChannel.options?.onActiveStreamsSnapshot?.(new Set(['msg-live']));
      });

      expect(dashIsStreaming()).toBe(true);
      expect(dashStop()).not.toBeNull();
    });

    // The dashboard store's setAgentStopStreaming is a plain zustand VALUE setter, not a
    // useState dispatch — so an updater-shaped argument (`() => fn`) is stored VERBATIM.
    // GlobalAssistantView was passing exactly that, so the slot held the outer wrapper and
    // SidebarChatTab's `dashboardStopStreaming()` merely RETURNED the inner fn instead of
    // running it: a Stop button that silently did nothing while the stream kept generating
    // and kept billing. Typechecked because `() => (() => Promise<void>)` is assignable to
    // `() => void`. Guard the invariant: whatever is in the slot must ACT when called.
    it('given a claimed stop fn in the slot, calling it must actually abort (not merely return another function)', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-stop', conversationId: CONV_ID });
      });

      const stop = dashStop();
      expect(typeof stop).toBe('function');

      const returned = stop!() as unknown;

      expect(mockAbortByMessageId).toHaveBeenCalledWith({ messageId: 'msg-stop' });
      expect(typeof returned).not.toBe('function');
    });

    // BUG EIGHT. The dashboard and the sidebar do NOT share an agent — GlobalAssistantView's
    // comes from usePageAgentDashboardStore, SidebarChatTab's from useSidebarAgentStore
    // (independent, localStorage-persisted). And GlobalAssistantView never unmounts;
    // CenterPanel only HIDES it. So after one dashboard visit the two are co-mounted on
    // every page, holding different agents, reading one slot.
    //
    // With no identity on the slot, a stream on the dashboard's agent B lit up the
    // sidebar's Stop for agent A — and clicking it aborted B while A kept generating and
    // kept billing. The slot now names its agent, and a reader asking about a different one
    // gets nothing.
    it("given ANOTHER agent's stream owns the slot, this surface must not see it as its own", () => {
      const otherAgentsStop = vi.fn();
      usePageAgentDashboardStore.setState({
        streamingAgentIds: { [key('agent-OTHER', CONV_ID)]: true },
        agentStops: { [key('agent-OTHER', CONV_ID)]: otherAgentsStop },
      });

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      // Our agent is AGENT.id; the slot belongs to agent-OTHER.
      expect(dashIsStreaming(AGENT.id)).toBe(false);
      expect(dashStop(AGENT.id)).toBeNull();

      // And the other agent's own view of it is intact.
      expect(dashIsStreaming('agent-OTHER')).toBe(true);
      expect(dashStop('agent-OTHER')).toBe(otherAgentsStop);
    });

    it("given another agent owns the slot, finalizing OUR stream must not clear THEIR state", () => {
      const otherAgentsStop = vi.fn();
      usePageAgentDashboardStore.setState({
        streamingAgentIds: { [key('agent-OTHER', CONV_ID)]: true },
        agentStops: { [key('agent-OTHER', CONV_ID)]: otherAgentsStop },
      });
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-ours', conversationId: CONV_ID });
      });
      act(() => {
        capturedChannel.options?.onOwnStreamFinalize?.({ messageId: 'msg-ours' });
      });

      expect(dashIsStreaming('agent-OTHER')).toBe(true);
      expect(dashStop('agent-OTHER')).toBe(otherAgentsStop);
    });

    // The single-slot shape had a second consequence beyond the cross-wire: whichever agent
    // claimed first held the ONLY slot, so a second agent streaming at the same time could
    // never get a Stop button at all. Keying by agent removes the artificial contention —
    // two agents streaming concurrently each keep their own control.
    it('given another agent is already streaming, this agent should still get its own Stop', () => {
      const otherAgentsStop = vi.fn();
      usePageAgentDashboardStore.setState({
        streamingAgentIds: { [key('agent-OTHER', CONV_ID)]: true },
        agentStops: { [key('agent-OTHER', CONV_ID)]: otherAgentsStop },
      });

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-ours', conversationId: CONV_ID });
      });

      // Ours was claimed...
      expect(dashIsStreaming(AGENT.id)).toBe(true);
      expect(typeof dashStop(AGENT.id)).toBe('function');
      // ...and theirs is untouched.
      expect(dashIsStreaming('agent-OTHER')).toBe(true);
      expect(dashStop('agent-OTHER')).toBe(otherAgentsStop);
    });

    // The last coarseness in the key. The dashboard and the sidebar keep INDEPENDENT
    // conversations for the SAME agent ("New Chat" in either diverges them). Keyed by agent
    // alone, a dashboard stream on conversation X2 still lit up the sidebar's Stop while it
    // was showing X1 — and clicking it aborted X2. Ownership is per stream, so the key is.
    it("given the same agent but a DIFFERENT conversation, this surface must not see that stream as its own", () => {
      const otherConvStop = vi.fn();
      usePageAgentDashboardStore.setState({
        streamingAgentIds: { [key(AGENT.id, 'conv-OTHER')]: true },
        agentStops: { [key(AGENT.id, 'conv-OTHER')]: otherConvStop },
      });

      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      // Same agent, our conversation: nothing.
      expect(dashIsStreaming(AGENT.id, CONV_ID)).toBe(false);
      expect(dashStop(AGENT.id, CONV_ID)).toBeNull();

      // The other conversation's own state is intact.
      expect(dashIsStreaming(AGENT.id, 'conv-OTHER')).toBe(true);
      expect(dashStop(AGENT.id, 'conv-OTHER')).toBe(otherConvStop);
    });

    // A stream in a conversation this surface is not showing is not ours to control — the
    // surface showing THAT conversation claims it. What must never happen is it leaking into
    // OUR key, which is what an agent-only key allowed.
    it("given a bootstrap for another conversation, it must not claim anything under OUR key", () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({
          messageId: 'msg-other-conv',
          conversationId: 'conv-OTHER',
        });
      });

      expect(dashIsStreaming(AGENT.id, CONV_ID)).toBe(false);
      expect(dashStop(AGENT.id, CONV_ID)).toBeNull();
    });

    // The claim is keyed by the STREAM's own conversation, so the DB bootstrap landing
    // before this surface has resolved its identity (which it is designed to tolerate)
    // cannot claim under the wrong conversation.
    it("given the surface's conversation is not resolved yet, the claim should be keyed to the STREAM's conversation", () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: null }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({
          messageId: 'msg-boot',
          conversationId: CONV_ID,
        });
      });

      expect(dashIsStreaming(AGENT.id, CONV_ID)).toBe(true);
      expect(typeof dashStop(AGENT.id, CONV_ID)).toBe('function');
    });

    // BUG TWELVE, from the hook's side. GlobalAssistantView used to key its flag/stop by the
    // surface's LIVE conversation. Because `useChat` only recreates its Chat when its `id`
    // changes (and GAV's is a constant), switching conversation mid-stream does NOT abort the
    // POST — so the key migrated: the running stream's entry was cleared and a fresh claim was
    // installed under a conversation with NO stream. The abandoned stream lost its Stop and
    // its SWR protection while still generating; the new key showed a Stop that aborted
    // nothing. GAV now keys by the conversation the stream STARTED in.
    //
    // From here, the invariant to hold is that a claim made for conversation X stays under X
    // even as the surface moves on.
    it('given the surface switches conversation while our claimed stream runs, the claim must stay under the STREAM\'s conversation', () => {
      seedDashboard({ agentStopStreaming: null });
      const { rerender } = renderHook(({ opts }) => useAgentChannelMultiplayer(opts), {
        initialProps: { opts: baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }) },
      });

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-x', conversationId: CONV_ID });
      });
      expect(dashIsStreaming(AGENT.id, CONV_ID)).toBe(true);

      // The user switches to another conversation on the same agent. The stream keeps running.
      act(() => {
        rerender({ opts: baseOptions({ selectedAgent: AGENT, agentConversationId: 'conv-NEW' }) });
      });

      // The claim is still where the stream is...
      expect(dashIsStreaming(AGENT.id, CONV_ID)).toBe(true);
      expect(typeof dashStop(AGENT.id, CONV_ID)).toBe('function');
      // ...and nothing was fabricated under the conversation we moved to.
      expect(dashIsStreaming(AGENT.id, 'conv-NEW')).toBe(false);
      expect(dashStop(AGENT.id, 'conv-NEW')).toBeNull();
    });

    // A NULL slot is FREE, not foreign. GlobalAssistantView nulls the stop fn on ordinary
    // paths (its effect's else-branch and cleanup fire whenever agentStatus is 'ready' —
    // which it is for the whole life of a BOOTSTRAPPED stream) without touching
    // isAgentStreaming. Treating that as "not ours" would skip setAgentStreaming(false)
    // and strand the surface showing "streaming" with no way out.
    it('given the stop fn was nulled by another surface, finalizing must still clear isAgentStreaming', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-boot', conversationId: CONV_ID });
      });
      expect(dashIsStreaming()).toBe(true);

      // Another surface's effect cleanup nulls the stop fn — it never touches the flag.
      act(() => { usePageAgentDashboardStore.setState({ agentStops: {} }); });

      act(() => {
        capturedChannel.options?.onOwnStreamFinalize?.({ messageId: 'msg-boot' });
      });

      expect(dashIsStreaming()).toBe(false);
    });

    // The stop slot is a single shared singleton, and GlobalAssistantView writes it
    // DIRECTLY from its own local status without going through the claim protocol. So by
    // the time this surface releases, the slot may belong to somebody else — and nulling
    // it then kills THEIR live Stop button and their isAgentStreaming flag mid-stream.
    it('given the slot has since been taken over by another surface, switching agents should NOT clobber it', () => {
      seedDashboard({ agentStopStreaming: null });
      const { rerender } = renderHook(({ opts }) => useAgentChannelMultiplayer(opts), {
        initialProps: { opts: baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }) },
      });

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-ours', conversationId: CONV_ID });
      });

      // Another surface (e.g. GlobalAssistantView) overwrites the shared slot.
      const someoneElsesStop = vi.fn();
      act(() => {
        usePageAgentDashboardStore.setState({ agentStops: { [key(AGENT.id, CONV_ID)]: someoneElsesStop } });
        usePageAgentDashboardStore.setState({ streamingAgentIds: { [key(AGENT.id, CONV_ID)]: true } });
      });

      // We switch agents. Our claim is stale — we must not touch their state.
      act(() => {
        rerender({ opts: baseOptions({ selectedAgent: { id: 'agent-b' }, agentConversationId: 'conv-b' }) });
      });

      expect(dashStop()).toBe(someoneElsesStop);
      expect(dashIsStreaming()).toBe(true);
    });

    // The sidebar swaps agents IN PLACE (no unmount), and useChannelStreamSocket tears
    // down its effect on that channelId change WITHOUT firing onOwnStreamFinalize (by
    // design). So the claim must be released by the channel-keyed cleanup — otherwise the
    // next agent's own stream finds the slot occupied, declines it, and its finalize does
    // not match the stale messageId: the dashboard is stuck streaming with a Stop button
    // wired to the PREVIOUS agent's dead message. (The old boolean ref recovered from this
    // by accident, so scoping the release by messageId without this is a regression.)
    it('given the agent is switched mid-stream, the stale claim should be released rather than stranding a dead Stop button', () => {
      seedDashboard({ agentStopStreaming: null });
      const { rerender } = renderHook(({ opts }) => useAgentChannelMultiplayer(opts), {
        initialProps: { opts: baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }) },
      });

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-agent-a', conversationId: CONV_ID });
      });
      expect(dashIsStreaming()).toBe(true);

      // Switch to a different agent — same component, new channel.
      act(() => {
        rerender({
          opts: baseOptions({ selectedAgent: { id: 'agent-b' }, agentConversationId: 'conv-b' }),
        });
      });

      expect(dashIsStreaming()).toBe(false);
      expect(dashStop()).toBeNull();
    });

    it('given the CLAIMING stream finalizes, the slot should be released', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({ selectedAgent: AGENT, agentConversationId: CONV_ID }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-claimer', conversationId: CONV_ID });
      });
      act(() => {
        capturedChannel.options?.onOwnStreamFinalize?.({ messageId: 'msg-claimer' });
      });

      expect(dashIsStreaming()).toBe(false);
      expect(dashStop()).toBeNull();
    });

    // Conversation-scoped: an own stream in ANOTHER conversation on this agent channel
    // must not light up the Stop button for the conversation on screen (it would abort
    // the wrong stream). Same class of bug as the remote-stream conversation filter.
    it('given onOwnStreamBootstrap fires for a DIFFERENT conversation, the slot should NOT be claimed', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({
          messageId: 'msg-other-conv',
          conversationId: 'a-different-conversation',
        });
      });

      expect(dashStop()).toBeNull();
      expect(dashIsStreaming()).toBe(false);
    });

    it('given onOwnStreamBootstrap fires while the dashboard stop slot is empty, the slot should be claimed', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own', conversationId: CONV_ID });
      });

      expect(typeof dashStop()).toBe('function');
      expect(dashIsStreaming()).toBe(true);
    });

    it('given onOwnStreamBootstrap fires while the slot is already populated, the existing slot should be preserved', () => {
      const existingStop = vi.fn();
      seedDashboard({ agentStopStreaming: { agentId: AGENT.id, stop: existingStop } });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own', conversationId: CONV_ID });
      });

      expect(dashStop()).toBe(existingStop);
    });

    it('given onOwnStreamFinalize fires after this surface claimed the slot, the slot should be cleared', () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own', conversationId: CONV_ID });
      });
      act(() => {
        capturedChannel.options?.onOwnStreamFinalize?.({ messageId: 'msg-own' });
      });

      expect(dashStop()).toBeNull();
      expect(dashIsStreaming()).toBe(false);
    });

    it('given onOwnStreamFinalize fires when this surface never claimed the slot, the existing stop should remain', () => {
      const otherSurfaceStop = vi.fn();
      seedDashboard({ agentStopStreaming: { agentId: AGENT.id, stop: otherSurfaceStop } });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      // Bootstrap fires but slot is occupied; this surface declines to claim.
      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own', conversationId: CONV_ID });
      });
      // Finalize arrives — must NOT clear the other surface's slot.
      act(() => {
        capturedChannel.options?.onOwnStreamFinalize?.({ messageId: 'msg-own' });
      });

      expect(dashStop()).toBe(otherSurfaceStop);
    });

    it("given the slot is claimed, calling the stop function in the slot should invoke the abort endpoint", () => {
      seedDashboard({ agentStopStreaming: null });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own', conversationId: CONV_ID });
      });

      const stop = dashStop();
      stop?.();

      expect(mockAbortByMessageId).toHaveBeenCalledWith({ messageId: 'msg-own' });
    });
  });

  describe('local message synthesis on stream complete', () => {
    it("given a stream finalizes whose conversationId matches the active agent conversation, the synthesized assistant message should be appended via setLocalMessages", () => {
      pendingStreams.current = new Map([
        [
          'msg-done',
          {
            messageId: 'msg-done',
            pageId: AGENT.id,
            conversationId: 'conv-active',
            triggeredBy: { userId: 'someone-else', displayName: 'X' },
            parts: [{ type: 'text', text: 'final response text' }],
            isOwn: false,
          },
        ],
      ]);

      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-done');
      });

      expect(setLocalMessages).toHaveBeenCalledTimes(1);
      const updater = setLocalMessages.mock.calls[0][0] as (prev: UIMessage[]) => UIMessage[];
      expect(updater([])).toEqual([
        {
          id: 'msg-done',
          role: 'assistant',
          parts: [{ type: 'text', text: 'final response text' }],
        },
      ]);
    });

    it("given a stream finalizes whose conversationId does not match the active agent conversation, setLocalMessages should not be called", () => {
      pendingStreams.current = new Map([
        [
          'msg-stale',
          {
            messageId: 'msg-stale',
            pageId: AGENT.id,
            conversationId: 'conv-different',
            triggeredBy: { userId: 'x', displayName: 'X' },
            parts: [{ type: 'text', text: 'belongs to different conversation' }],
            isOwn: false,
          },
        ],
      ]);

      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-stale');
      });

      expect(setLocalMessages).not.toHaveBeenCalled();
    });

    it('given a stream finalizes with empty parts, setLocalMessages should not be called', () => {
      pendingStreams.current = new Map([
        [
          'msg-empty',
          {
            messageId: 'msg-empty',
            pageId: AGENT.id,
            conversationId: 'conv-active',
            triggeredBy: { userId: 'x', displayName: 'X' },
            parts: [],
            isOwn: false,
          },
        ],
      ]);

      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      act(() => {
        capturedChannel.options?.onStreamComplete?.('msg-empty');
      });

      expect(setLocalMessages).not.toHaveBeenCalled();
    });
  });

  describe('remote user-message broadcast', () => {
    it('given onUserMessage fires with conversationId matching the active agent conversation, should append via setLocalMessages', () => {
      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      const remoteUser = { id: 'u-1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'remote prompt' }] };
      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, {
          message: remoteUser,
          pageId: AGENT.id,
          conversationId: 'conv-active',
          triggeredBy: { userId: 'other', displayName: 'Other', browserSessionId: 'sess-x' },
        });
      });

      expect(setLocalMessages).toHaveBeenCalledTimes(1);
      const updater = setLocalMessages.mock.calls[0][0] as (prev: UIMessage[]) => UIMessage[];
      expect(updater([])).toEqual([remoteUser]);
    });

    it('given onUserMessage fires for a different conversationId, should NOT call setLocalMessages', () => {
      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      const remoteUser = { id: 'u-1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'wrong conv' }] };
      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, {
          message: remoteUser,
          pageId: AGENT.id,
          conversationId: 'conv-different',
          triggeredBy: { userId: 'other', displayName: 'Other', browserSessionId: 'sess-x' },
        });
      });

      expect(setLocalMessages).not.toHaveBeenCalled();
    });

    it('given onUserMessage fires for a messageId already in messages, the updater should leave the array unchanged', () => {
      const setLocalMessages = vi.fn();
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: 'conv-active',
        setLocalMessages,
      }));

      const remoteUser = { id: 'u-already', role: 'user' as const, parts: [{ type: 'text' as const, text: 'dup' }] };
      act(() => {
        capturedChannel.options?.onUserMessage?.(remoteUser, {
          message: remoteUser,
          pageId: AGENT.id,
          conversationId: 'conv-active',
          triggeredBy: { userId: 'other', displayName: 'Other', browserSessionId: 'sess-x' },
        });
      });

      const updater = setLocalMessages.mock.calls[0][0] as (prev: UIMessage[]) => UIMessage[];
      const prev = [remoteUser];
      expect(updater(prev)).toBe(prev); // same reference — no append happened
    });
  });

  describe('reconnect refresh', () => {
    it('given the very first connect, the surface-provided loadConversation should NOT be called (mount-time load already covers it)', () => {
      seedDashboard();
      const surfaceLoadConversation = vi.fn();
      mockSocketStatus.current = 'disconnected';
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            selectedAgent: AGENT,
            agentConversationId: CONV_ID,
            loadConversation: surfaceLoadConversation,
          }));
        },
        {
          initialProps: {
            status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
          },
        },
      );

      // First connect.
      result.rerender({ status: 'connected' });
      expect(surfaceLoadConversation).not.toHaveBeenCalled();
    });

    it('given a reconnect AFTER the initial connect, the surface-provided loadConversation should be called with the active conversation id', () => {
      seedDashboard();
      const surfaceLoadConversation = vi.fn();
      mockSocketStatus.current = 'disconnected';
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            selectedAgent: AGENT,
            agentConversationId: CONV_ID,
            loadConversation: surfaceLoadConversation,
          }));
        },
        {
          initialProps: {
            status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
          },
        },
      );

      // First connect — primes hasInitialConnect, no refresh.
      result.rerender({ status: 'connected' });
      expect(surfaceLoadConversation).not.toHaveBeenCalled();

      // Goes offline, then reconnects.
      result.rerender({ status: 'disconnected' });
      result.rerender({ status: 'connected' });

      expect(surfaceLoadConversation).toHaveBeenCalledTimes(1);
      expect(surfaceLoadConversation).toHaveBeenCalledWith('conv-1');
    });

    it('given a custom loadConversation is provided, the dashboard store loadConversation should NOT be called (the surface owns the refresh path — sidebar agent state vs dashboard state)', () => {
      seedDashboard();
      const dashboardLoad = vi.fn();
      usePageAgentDashboardStore.setState({ loadConversation: dashboardLoad });
      const surfaceLoadConversation = vi.fn();

      mockSocketStatus.current = 'disconnected';
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            selectedAgent: AGENT,
            agentConversationId: CONV_ID,
            loadConversation: surfaceLoadConversation,
          }));
        },
        {
          initialProps: {
            status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
          },
        },
      );

      // Initial connect, then reconnect.
      result.rerender({ status: 'connected' });
      result.rerender({ status: 'disconnected' });
      result.rerender({ status: 'connected' });

      expect(surfaceLoadConversation).toHaveBeenCalledWith('conv-1');
      expect(dashboardLoad).not.toHaveBeenCalled();
    });

    it('given selectedAgent is null, reconnect should never trigger a refresh', () => {
      seedDashboard();
      const surfaceLoadConversation = vi.fn();
      const result = renderHook(
        ({ status }: { status: 'disconnected' | 'connecting' | 'connected' | 'error' }) => {
          mockSocketStatus.current = status;
          return useAgentChannelMultiplayer(baseOptions({
            loadConversation: surfaceLoadConversation,
          }));
        },
        {
          initialProps: {
            status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
          },
        },
      );

      result.rerender({ status: 'connected' });
      result.rerender({ status: 'disconnected' });
      result.rerender({ status: 'connected' });

      expect(surfaceLoadConversation).not.toHaveBeenCalled();
    });
  });

  describe('cleanup on unmount', () => {
    it('given this surface claimed the dashboard stop slot then unmounts mid-stream, the slot should be cleared on cleanup', () => {
      seedDashboard({ agentStopStreaming: null });
      const { unmount } = renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      // Bootstrap claims the slot.
      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own', conversationId: CONV_ID });
      });
      expect(typeof dashStop()).toBe('function');

      // Surface unmounts before stream finalizes (e.g. user navigates away).
      // useChannelStreamSocket aborts the controller but does NOT fire
      // onOwnStreamFinalize, so the hook's own cleanup must clear the slot.
      unmount();

      expect(dashStop()).toBeNull();
      expect(dashIsStreaming()).toBe(false);
    });

    it('given this surface never claimed the slot, unmount should NOT clear another writer\'s slot', () => {
      const otherSurfaceStop = vi.fn();
      seedDashboard({ agentStopStreaming: { agentId: AGENT.id, stop: otherSurfaceStop }, isAgentStreaming: true });
      const { unmount } = renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      // Bootstrap fires but slot is occupied — this surface declines.
      act(() => {
        capturedChannel.options?.onOwnStreamBootstrap?.({ messageId: 'msg-own', conversationId: CONV_ID });
      });
      // Surface unmounts. The other writer's slot must survive.
      unmount();

      expect(dashStop()).toBe(otherSurfaceStop);
      expect(dashIsStreaming()).toBe(true);
    });
  });

  describe('editing-store registration', () => {
    it('given a selected agent, the registration key should be `ai-channel-${agent.id}`', () => {
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
        isLocallyStreaming: true,
      }));

      const lastCall = mockUseStreamingRegistration.mock.calls.at(-1);
      expect(lastCall?.[0]).toBe(`ai-channel-${AGENT.id}`);
      expect(lastCall?.[1]).toBe(true); // isLocallyStreaming → registration true
    });

    it('given selectedAgent is null, the registration should be inactive (isStreaming=false)', () => {
      renderWiring(baseOptions({
        isLocallyStreaming: true,
      }));

      const lastCall = mockUseStreamingRegistration.mock.calls.at(-1);
      expect(lastCall?.[1]).toBe(false);
    });

    it('given an agent and the dashboard store reports streaming (e.g. bootstrap-replay), the registration should be active even if the surface itself is not streaming', () => {
      seedDashboard({ isAgentStreaming: true });
      renderWiring(baseOptions({
        selectedAgent: AGENT,
        agentConversationId: CONV_ID,
      }));

      const lastCall = mockUseStreamingRegistration.mock.calls.at(-1);
      expect(lastCall?.[1]).toBe(true);
    });
  });
});

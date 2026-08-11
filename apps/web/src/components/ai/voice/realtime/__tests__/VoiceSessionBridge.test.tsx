/**
 * The settled rule, asserted against the real thing: NAVIGATING DOES NOT
 * REBIND, SWITCHING DOES.
 *
 * Both arrive as the same change to the derived target, so the only way to tell
 * these apart is a test that performs each one and counts calls. A regression
 * here — the obvious "watch the target and call start" refactor — hangs up the
 * user's call every time they open a page, and nothing else in the suite would
 * notice.
 *
 * The provider, the bridge, the binding hook, the agent stores and the rebind
 * store are all REAL. Only the network and the router are faked.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceSessionProvider, useVoiceSessionControls } from '@/contexts/VoiceSessionContext';
import { useSidebarAgentStore } from '@/hooks/page-agents';
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { useVoiceRebindStore } from '@/stores/useVoiceRebindStore';
import { NO_REBIND_INTENT } from '@/lib/ai/realtime/voice-rebind';

const { mockConnect, routeState, globalConversation, resolveSpy, stopSpy } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  routeState: { pathname: '/dashboard/drive-1/page-1', params: {} as Record<string, string> },
  globalConversation: { currentConversationId: null as string | null },
  resolveSpy: vi.fn(),
  stopSpy: vi.fn(),
}));

vi.mock('@/lib/ai/realtime/connect', () => ({
  connectVoiceCall: mockConnect,
  VOICE_CALL_ROUTE: '/api/voice/realtime/call',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => routeState.pathname,
  useParams: () => routeState.params,
}));

vi.mock('@/contexts/GlobalChatContext', () => ({
  useGlobalChatConversation: () => globalConversation,
}));

vi.mock('@/hooks/useDrive', () => {
  const state = { drives: [] as unknown[], fetchDrives: vi.fn().mockResolvedValue(undefined) };
  const useDriveStore = (selector: (s: typeof state) => unknown) => selector(state);
  useDriveStore.getState = () => state;
  return { useDriveStore };
});

vi.mock('@/lib/ai/shared/resolveLocationContext', () => ({
  resolveLocationContext: resolveSpy,
}));

import { VoiceSessionBridge } from '../VoiceSessionBridge';

const connection = (callId: string) => ({
  callId,
  attached: true,
  maxDurationMs: undefined,
  microphone: { getTracks: () => [], getAudioTracks: () => [] },
  setMicrophoneEnabled: vi.fn(),
  stop: stopSpy,
});

const agent = (id: string) => ({
  id,
  title: id,
  driveId: 'd1',
  driveName: 'D',
  systemPrompt: '',
  aiProvider: 'openai',
  aiModel: 'gpt-4',
  enabledTools: [],
});

/** Starts a call the way the trigger would, without dragging the trigger in. */
function StartButton() {
  const { start } = useVoiceSessionControls();
  return (
    <button
      type="button"
      data-testid="start"
      onClick={() =>
        void start({
          conversationId: 'conv-a',
          type: 'page',
          contextId: 'agent-a',
          agentPageId: 'agent-a',
        })
      }
    />
  );
}

/**
 * A FRESH element each time. Handing `rerender` the identical element
 * reference lets React bail out of the render entirely, and the navigation
 * under test would then never reach the bridge.
 */
const tree = () => (
  <VoiceSessionProvider>
    <VoiceSessionBridge />
    <StartButton />
  </VoiceSessionProvider>
);

const renderBridge = () => render(tree());

/**
 * A route change. `usePathname` is a mock reading a mutable object, so moving
 * it is not by itself something React re-renders for — the rerender is what
 * makes this a navigation rather than a variable assignment.
 */
const navigateTo = async (
  view: ReturnType<typeof render>,
  pathname: string,
) => {
  await act(async () => {
    routeState.pathname = pathname;
    view.rerender(tree());
  });
};

const startCall = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('start'));
  });
  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
};

beforeEach(() => {
  vi.clearAllMocks();
  routeState.pathname = '/dashboard/drive-1/page-1';
  routeState.params = { driveId: 'drive-1', pageId: 'page-1' };
  globalConversation.currentConversationId = null;
  resolveSpy.mockResolvedValue({ label: null, locationContext: null });
  useSidebarAgentStore.setState({ selectedAgent: agent('agent-a'), conversationId: 'conv-a' });
  usePageAgentDashboardStore.setState({ selectedAgent: null, conversationId: null });
  useVoiceRebindStore.setState({ intent: NO_REBIND_INTENT });
  mockConnect.mockImplementation(async () => ({ ok: true, connection: connection('rtc_1') }));
});

describe('VoiceSessionBridge — navigating', () => {
  it('should NOT rebind when the route changes under a live call', async () => {
    const view = renderBridge();
    await startCall();

    // Walk to a different page — and, to make it as tempting as possible for a
    // target-watching implementation, to a page whose sidebar agent differs.
    await act(async () => {
      useSidebarAgentStore.setState({
        selectedAgent: agent('agent-b'),
        conversationId: 'conv-b',
      });
    });
    await navigateTo(view, '/dashboard/drive-1/page-2');

    // One call, still the first one. Nothing was torn down.
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('should update where the user is standing instead', async () => {
    const view = renderBridge();
    await startCall();
    resolveSpy.mockClear();

    await navigateTo(view, '/dashboard/drive-1/page-2');

    await waitFor(() => expect(resolveSpy).toHaveBeenCalled());
    expect(resolveSpy.mock.calls.at(-1)?.[0]).toBe('/dashboard/drive-1/page-2');
    // And still exactly one call.
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('should resolve nothing at all while no call is running', async () => {
    // Two API calls per navigation, app-wide, for a feature nobody started.
    const view = renderBridge();
    await navigateTo(view, '/dashboard/drive-1/page-3');

    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

describe('VoiceSessionBridge — the agent switcher', () => {
  it('should rebind the live call once the chosen agent\'s conversation resolves', async () => {
    renderBridge();
    await startCall();

    // What the switcher does: record the intent, then let the store re-resolve.
    await act(async () => {
      useVoiceRebindStore.getState().requestRebind('agent-b');
      useSidebarAgentStore.setState({ selectedAgent: agent('agent-b'), conversationId: null });
    });

    // Nothing yet — there is no conversation to bind to.
    expect(mockConnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      useSidebarAgentStore.setState({ conversationId: 'conv-b' });
    });

    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2));
    expect(mockConnect.mock.calls[1][0].target).toEqual({
      conversationId: 'conv-b',
      type: 'page',
      contextId: 'agent-b',
      agentPageId: 'agent-b',
    });
    // A rebind tears the old call down — that is the difference from a chain.
    expect(stopSpy).toHaveBeenCalled();
    // And the intent is spent, not left to fire again.
    expect(useVoiceRebindStore.getState().intent).toEqual(NO_REBIND_INTENT);
  });

  it('should carry the location learned WHILE navigating into the rebound call', async () => {
    const view = renderBridge();
    await startCall();

    resolveSpy.mockResolvedValue({
      label: 'Page 2',
      locationContext: {
        currentPage: { id: 'page-2', title: 'Page 2', type: 'DOCUMENT', path: '/d/Page 2' },
        currentDrive: null,
      },
    });

    await navigateTo(view, '/dashboard/drive-1/page-2');
    await waitFor(() => expect(resolveSpy).toHaveBeenCalled());

    await act(async () => {
      useVoiceRebindStore.getState().requestRebind('agent-b');
      useSidebarAgentStore.setState({ selectedAgent: agent('agent-b'), conversationId: 'conv-b' });
    });

    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2));
    expect(mockConnect.mock.calls[1][0].locationContext).toEqual({
      currentPage: { id: 'page-2', title: 'Page 2', type: 'DOCUMENT', path: '/d/Page 2' },
    });
  });

  it('should drop an intent recorded while nothing is live, rather than hoard it', async () => {
    renderBridge();

    await act(async () => {
      useVoiceRebindStore.getState().requestRebind('agent-b');
      useSidebarAgentStore.setState({ selectedAgent: agent('agent-b'), conversationId: 'conv-b' });
    });

    await waitFor(() =>
      expect(useVoiceRebindStore.getState().intent).toEqual(NO_REBIND_INTENT),
    );
    // Switching agent with nothing running is just switching agent.
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

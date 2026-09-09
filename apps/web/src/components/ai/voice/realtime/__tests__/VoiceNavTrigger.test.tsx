/**
 * The one voice control, driven end to end against the REAL session provider
 * and the REAL binding hook. Only the network (`connectVoiceCall`), the router
 * and the location resolver are fakes.
 *
 * Mocking `useVoiceBinding` here would have made the whole file vacuous: the
 * behaviour worth guarding is precisely that the button binds to the assistant
 * in view, which is a fact about the stores, the route and the hook together.
 * So the stores are real and driven with `setState`.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceSessionProvider } from '@/contexts/VoiceSessionContext';
import { useSidebarAgentStore } from '@/hooks/page-agents';
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { micFailureMessage } from '@/lib/voice/mic-errors';

const { mockConnect, routeState, globalConversation, toastError, stopSpy, setMicSpy } =
  vi.hoisted(() => ({
    mockConnect: vi.fn(),
    routeState: { pathname: '/dashboard/drive-1/page-1', params: {} as Record<string, string> },
    globalConversation: { currentConversationId: null as string | null },
    toastError: vi.fn(),
    stopSpy: vi.fn(),
    setMicSpy: vi.fn(),
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
  resolveLocationContext: vi.fn().mockResolvedValue({ label: null, locationContext: null }),
}));

vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

import { VoiceNavTrigger } from '../VoiceNavTrigger';

const onReveal = vi.fn();

const renderTrigger = () =>
  render(
    <VoiceSessionProvider>
      <VoiceNavTrigger onReveal={onReveal} />
    </VoiceSessionProvider>,
  );

const liveConnection = {
  callId: 'rtc_1',
  attached: true,
  maxDurationMs: undefined,
  microphone: { getTracks: () => [], getAudioTracks: () => [] },
  setMicrophoneEnabled: setMicSpy,
  stop: stopSpy,
};

const agent = {
  id: 'agent-a',
  title: 'Agent A',
  driveId: 'd1',
  driveName: 'D',
  systemPrompt: '',
  aiProvider: 'openai',
  aiModel: 'gpt-4',
  enabledTools: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  routeState.pathname = '/dashboard/drive-1/page-1';
  routeState.params = { driveId: 'drive-1', pageId: 'page-1' };
  globalConversation.currentConversationId = null;
  useSidebarAgentStore.setState({ selectedAgent: null, conversationId: null });
  usePageAgentDashboardStore.setState({ selectedAgent: null, conversationId: null });
  mockConnect.mockResolvedValue({ ok: true, connection: liveConnection });
});

afterEach(() => {
  useSidebarAgentStore.setState({ selectedAgent: null, conversationId: null });
  usePageAgentDashboardStore.setState({ selectedAgent: null, conversationId: null });
});

describe('VoiceNavTrigger — nothing connects until it is pressed', () => {
  it('should open no call, and ask for no microphone, on mount', () => {
    useSidebarAgentStore.setState({ selectedAgent: agent, conversationId: 'conv-a' });
    renderTrigger();

    expect(mockConnect).not.toHaveBeenCalled();
    expect(screen.getByTestId('voice-nav-trigger')).toHaveAttribute('data-voice-state', 'idle');
  });
});

describe('VoiceNavTrigger — binding to the assistant in view', () => {
  it('should bind a page route to the SIDEBAR agent and reveal the sidebar', async () => {
    useSidebarAgentStore.setState({ selectedAgent: agent, conversationId: 'conv-sidebar' });
    // A different pair sitting in the dashboard store: picking that one is the
    // failure this asserts against.
    usePageAgentDashboardStore.setState({
      selectedAgent: { ...agent, id: 'agent-dash' },
      conversationId: 'conv-dashboard',
    });

    renderTrigger();
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-nav-trigger'));
    });

    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    expect(mockConnect.mock.calls[0][0].target).toEqual({
      conversationId: 'conv-sidebar',
      type: 'page',
      contextId: 'agent-a',
      agentPageId: 'agent-a',
    });
    expect(onReveal).toHaveBeenCalledWith('sidebar');
  });

  it('should bind the dashboard to the view already on screen, not to the sidebar', async () => {
    // The dashboard's right sidebar has NO chat tab. A trigger that bound to it
    // there would be a dead press on the app's most-visited route.
    routeState.pathname = '/dashboard';
    routeState.params = {};
    useSidebarAgentStore.setState({ selectedAgent: agent, conversationId: 'conv-sidebar' });
    globalConversation.currentConversationId = 'conv-global';

    renderTrigger();
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-nav-trigger'));
    });

    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    expect(mockConnect.mock.calls[0][0].target).toEqual({
      conversationId: 'conv-global',
      type: 'global',
    });
    expect(onReveal).toHaveBeenCalledWith('dashboard');
  });

  it('should refuse to start while the conversation is still resolving', () => {
    // An agent chosen a moment ago, its conversation not yet resolved.
    useSidebarAgentStore.setState({ selectedAgent: agent, conversationId: null });
    renderTrigger();

    const button = screen.getByTestId('voice-nav-trigger');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('should carry the resolved location, so the first spoken question has a place', async () => {
    const { resolveLocationContext } = await import('@/lib/ai/shared/resolveLocationContext');
    vi.mocked(resolveLocationContext).mockResolvedValueOnce({
      label: 'Notes',
      locationContext: {
        currentPage: { id: 'page-1', title: 'Notes', type: 'DOCUMENT', path: '/d/Notes' },
        currentDrive: null,
      },
    });
    useSidebarAgentStore.setState({ selectedAgent: agent, conversationId: 'conv-a' });

    renderTrigger();
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-nav-trigger'));
    });

    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    // Nulls converted to absence, per the wire schema.
    expect(mockConnect.mock.calls[0][0].locationContext).toEqual({
      currentPage: { id: 'page-1', title: 'Notes', type: 'DOCUMENT', path: '/d/Notes' },
    });
  });
});

describe('VoiceNavTrigger — the live indicator is not a hang-up button', () => {
  it('should reveal the call, and NOT end it, when pressed while live', async () => {
    useSidebarAgentStore.setState({ selectedAgent: agent, conversationId: 'conv-a' });
    renderTrigger();

    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-nav-trigger'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('voice-nav-trigger')).toHaveAttribute('data-voice-state', 'live'),
    );
    expect(screen.getByTestId('voice-live-dot')).toBeInTheDocument();

    onReveal.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-nav-trigger'));
    });

    expect(onReveal).toHaveBeenCalledWith('sidebar');
    // The two things a toggle would have done and this must never do.
    expect(stopSpy).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('voice-nav-trigger')).toHaveAttribute('data-voice-state', 'live');
  });

  it('should show a call the server never joined as degraded, not as failed', async () => {
    mockConnect.mockResolvedValue({
      ok: true,
      connection: { ...liveConnection, attached: false },
    });
    useSidebarAgentStore.setState({ selectedAgent: agent, conversationId: 'conv-a' });
    renderTrigger();

    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-nav-trigger'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('voice-nav-trigger')).toHaveAttribute(
        'data-voice-state',
        'degraded',
      ),
    );
    // Still a call in progress: the dot is about whether the mic is open.
    expect(screen.getByTestId('voice-live-dot')).toBeInTheDocument();
  });
});

describe('VoiceNavTrigger — a refused microphone and an absent one are different', () => {
  const failWith = (reason: string, message: string) => {
    mockConnect.mockResolvedValue({ ok: false, reason, message, detail: 'detail' });
  };

  const press = async () => {
    useSidebarAgentStore.setState({ selectedAgent: agent, conversationId: 'conv-a' });
    renderTrigger();
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-nav-trigger'));
    });
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Let the trigger's own post-failure state settle before the test ends,
    // so the failure path is not reported as an un-acted update.
    await act(async () => {});
  };

  it('should tell a denied user how to grant it, and offer to try again', async () => {
    const denied = micFailureMessage('denied', false);
    failWith('mic-denied', denied);
    await press();

    expect(toastError.mock.calls[0][0]).toBe(denied);
    expect(toastError.mock.calls[0][1]?.action?.label).toBe('Try again');
  });

  it('should tell a user with NO microphone something else, and offer no retry', async () => {
    const missing = micFailureMessage('missing', false);
    failWith('mic-missing', missing);
    await press();

    expect(toastError.mock.calls[0][0]).toBe(missing);
    // Retrying cannot conjure hardware; a button that always fails teaches the
    // wrong lesson.
    expect(toastError.mock.calls[0][1]?.action).toBeUndefined();
    // And the two sentences are genuinely different advice, not one message.
    expect(missing).not.toBe(micFailureMessage('denied', false));
  });

  it('should report a failure even with every panel closed — it is the only reporter', async () => {
    // No chat surface is rendered in this file at all. The toast is what makes
    // the microphone honest on a route where the sidebar is collapsed.
    failWith('unavailable', 'Voice is not configured for this deployment.');
    await press();
    expect(toastError).toHaveBeenCalledWith(
      'Voice is not configured for this deployment.',
      expect.anything(),
    );
  });
});

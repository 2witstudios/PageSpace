import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import React from 'react';

// --- Mocks (hoisted so vi.mock factories can reference them) ---

const { mockUseSocketStore } = vi.hoisted(() => ({
  mockUseSocketStore: vi.fn(),
}));

vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: mockUseSocketStore,
}));

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('@/lib/ai/core/conversation-state', () => ({
  conversationState: {
    getActiveConversationId: vi.fn().mockReturnValue(null),
    getActiveAgentId: vi.fn().mockReturnValue(null),
    setActiveConversationId: vi.fn(),
    createAndSetActiveConversation: vi.fn(),
  },
}));

vi.mock('@/lib/url-state', () => ({
  getConversationId: vi.fn().mockReturnValue(null),
  getAgentId: vi.fn().mockReturnValue(null),
  setConversationId: vi.fn(),
}));

vi.mock('@/lib/ai/shared', () => ({
  useChatTransport: vi.fn().mockReturnValue(null),
}));

import { GlobalChatProvider, useGlobalChatConversation } from '../GlobalChatContext';

// --- Helpers ---

const CONV_ID = 'conv-1';

const okResponse = (data: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) });

const defaultFetch = (url: string) => {
  if (url === '/api/ai/global/active') return okResponse({ id: CONV_ID });
  if (url.includes('/messages')) return okResponse([]);
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
};

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <GlobalChatProvider>{children}</GlobalChatProvider>
);

// --- Tests ---

describe('GlobalChatProvider — socket reconnect refresh', () => {
  let mockConnectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';

  beforeEach(() => {
    mockConnectionStatus = 'disconnected';
    vi.clearAllMocks();
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: mockConnectionStatus })
    );
    mockFetchWithAuth.mockImplementation(defaultFetch);
  });

  const renderProvider = () =>
    renderHook(() => useGlobalChatConversation(), { wrapper: Wrapper });

  const setStatus = (
    status: 'disconnected' | 'connecting' | 'connected' | 'error',
    rerender: () => void
  ) => {
    act(() => {
      mockConnectionStatus = status;
      mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
        selector({ connectionStatus: status })
      );
      rerender();
    });
  };

  it('given isInitialized=true and currentConversationId set, when socket reconnects (second connect), should call refreshConversation exactly once', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // First connect — sets the ref, no refresh
    setStatus('connected', rerender);

    const messagesCallsAfterFirstConnect = mockFetchWithAuth.mock.calls.filter(
      ([url]) => (url as string).includes('/messages')
    ).length;

    // Disconnect then reconnect
    setStatus('disconnected', rerender);
    setStatus('connected', rerender);

    await waitFor(() => {
      const messageCalls = mockFetchWithAuth.mock.calls.filter(
        ([url]) => (url as string).includes('/messages')
      );
      expect(messageCalls.length).toBe(messagesCallsAfterFirstConnect + 1);
    });
  });

  it('given socket fires connected for the first time (initial load), should NOT call refreshConversation', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    const callsBefore = mockFetchWithAuth.mock.calls.length;

    // First connect
    setStatus('connected', rerender);

    await waitFor(() => expect(mockFetchWithAuth.mock.calls.length).toBe(callsBefore));
  });

  // NOTE: React testing-library's act() collapses isInitialized false→true into one render,
  // masking the production loop in isolation. This test validates the no-cascade invariant.
  // Two fixes in GlobalChatContext guard against the loop: prevConnectionStatusRef (prevents
  // the effect re-firing when status hasn't changed) and isInitializedRef (prevents isInitialized
  // from being a reactive dep that re-triggers the effect after each refresh).
  it('given refresh completes after reconnect (isInitialized cycles true→false→true), should NOT trigger a second refresh', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // First connect — sets hasInitialConnectRef, no refresh
    setStatus('connected', rerender);
    setStatus('disconnected', rerender);

    // Capture count BEFORE the reconnect so we can detect growth
    const countBeforeReconnect = mockFetchWithAuth.mock.calls.filter(
      ([url]) => (url as string).includes('/messages')
    ).length;

    // Reconnect — triggers the reconnect refresh
    setStatus('connected', rerender);

    // Wait until the reconnect refresh has fired (messages count grew by 1)
    await waitFor(() => {
      const calls = mockFetchWithAuth.mock.calls.filter(([url]) => (url as string).includes('/messages'));
      expect(calls.length).toBeGreaterThan(countBeforeReconnect);
    });

    const countAfterFirstRefresh = mockFetchWithAuth.mock.calls.filter(
      ([url]) => (url as string).includes('/messages')
    ).length;

    // Allow any cascade effects to settle
    await waitFor(() =>
      expect(
        mockFetchWithAuth.mock.calls.filter(([url]) => (url as string).includes('/messages')).length
      ).toBe(countAfterFirstRefresh)
    );

    // No second refresh should have fired
    expect(
      mockFetchWithAuth.mock.calls.filter(([url]) => (url as string).includes('/messages')).length
    ).toBe(countAfterFirstRefresh);
  });

  it('given socket is already connected when currentConversationId changes (conversation switch), should NOT trigger a spurious refresh', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // Initial connect — sets hasInitialConnectRef, no refresh
    setStatus('connected', rerender);

    const CONV_ID_2 = 'conv-2';
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/ai/global/${CONV_ID_2}/messages?limit=50`) return okResponse([]);
      return defaultFetch(url);
    });

    const callsBefore = mockFetchWithAuth.mock.calls.filter(
      ([url]) => (url as string).includes('/messages')
    ).length;

    // Switch conversation while connected — should NOT trigger reconnect refresh
    act(() => { result.current.loadConversation(CONV_ID_2); });

    // Wait for the load to complete
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID_2));

    const callsAfter = mockFetchWithAuth.mock.calls.filter(
      ([url]) => (url as string).includes('/messages')
    ).length;

    // Only the explicit loadConversation fetch, no extra reconnect refresh
    expect(callsAfter).toBe(callsBefore + 1);
  });

  it('given isInitialized=false when reconnect fires, should NOT call refreshConversation', async () => {
    // Hang initialization so isInitialized stays false
    mockFetchWithAuth.mockImplementation(() => new Promise(() => {}));

    const { result, rerender } = renderProvider();

    expect(result.current.isInitialized).toBe(false);

    // First connect — sets hasInitialConnectRef to true
    setStatus('connected', rerender);
    setStatus('disconnected', rerender);
    // Second connect — isInitialized still false, should not refresh
    setStatus('connected', rerender);

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(1));
  });
});

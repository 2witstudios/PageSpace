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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    expect(mockFetchWithAuth.mock.calls.length).toBe(callsBefore);
  });

  // NOTE: React testing-library's act() collapses isInitialized false→true into one render,
  // masking the production loop. This test validates the invariant in the test environment;
  // the fix (isInitializedRef) prevents the loop in production where renders are unbatched.
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

    // Allow any cascade effects to fire (isInitialized cycling back to true)
    await act(async () => { await new Promise(r => setTimeout(r, 100)); });

    // No second refresh should have fired
    expect(
      mockFetchWithAuth.mock.calls.filter(([url]) => (url as string).includes('/messages')).length
    ).toBe(countAfterFirstRefresh);
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Only the one hanging init call, no refresh calls
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });
});

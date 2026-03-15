import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock dependencies before imports
const mockUseMCP = vi.fn();
const mockUseMCPStore = vi.fn();

vi.mock('@/hooks/useMCP', () => ({
  useMCP: () => mockUseMCP(),
}));

vi.mock('@/stores/useMCPStore', () => ({
  useMCPStore: (selector: (state: Record<string, unknown>) => unknown) => mockUseMCPStore(selector),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { useMCPTools } from '../useMCPTools';
import { toast } from 'sonner';

describe('useMCPTools', () => {
  // Default mock store functions
  const mockGetEnabledServers = vi.fn((chatId: string, names: string[]) => names);
  const mockAreAllServersEnabled = vi.fn(() => true);
  const mockIsServerEnabled = vi.fn(() => true);
  const mockSetServerEnabled = vi.fn();
  const mockSetAllServersEnabled = vi.fn();

  function setupMocks(opts: {
    isDesktop?: boolean;
    serverStatuses?: Record<string, { status: string; toolsReady?: boolean }>;
  } = {}) {
    const {
      isDesktop = false,
      serverStatuses = {},
    } = opts;

    mockUseMCP.mockReturnValue({
      isDesktop,
      serverStatuses,
    });

    // The store uses selectors - each call gets a different selector function
    let callCount = 0;
    mockUseMCPStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) => {
      callCount++;
      // Return values based on call order matching the hook's selector order
      const selectorStr = selector.toString();
      if (selectorStr.includes('perChatServerMCP')) return {};
      if (selectorStr.includes('getEnabledServers')) return mockGetEnabledServers;
      if (selectorStr.includes('areAllServersEnabled')) return mockAreAllServersEnabled;
      if (selectorStr.includes('isServerEnabled')) return mockIsServerEnabled;
      if (selectorStr.includes('setServerEnabled')) return mockSetServerEnabled;
      if (selectorStr.includes('setAllServersEnabled')) return mockSetAllServersEnabled;
      return undefined;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: not desktop, no servers
    setupMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('given not desktop, should return isDesktop false and empty arrays', () => {
    setupMocks({ isDesktop: false });

    const { result } = renderHook(() => useMCPTools({ conversationId: 'conv-1' }));

    expect(result.current.isDesktop).toBe(false);
    expect(result.current.runningServers).toBe(0);
    expect(result.current.runningServerNames).toEqual([]);
    expect(result.current.mcpToolSchemas).toEqual([]);
  });

  it('given desktop with running servers, should report running server names', () => {
    setupMocks({
      isDesktop: true,
      serverStatuses: {
        'server-a': { status: 'running', toolsReady: true },
        'server-b': { status: 'stopped' },
        'server-c': { status: 'running', toolsReady: true },
      },
    });

    const { result } = renderHook(() => useMCPTools({ conversationId: 'conv-1' }));

    expect(result.current.isDesktop).toBe(true);
    expect(result.current.runningServers).toBe(2);
    expect(result.current.runningServerNames).toEqual(['server-a', 'server-c']);
  });

  it('given server status running but toolsReady false, should not include it', () => {
    setupMocks({
      isDesktop: true,
      serverStatuses: {
        'server-a': { status: 'running', toolsReady: false },
      },
    });

    const { result } = renderHook(() => useMCPTools({ conversationId: 'conv-1' }));

    expect(result.current.runningServers).toBe(0);
    expect(result.current.runningServerNames).toEqual([]);
  });

  it('given null conversationId, should use "global" as chatId for store calls', () => {
    setupMocks({ isDesktop: false });

    renderHook(() => useMCPTools({ conversationId: null }));

    // The store getEnabledServers is called with chatId
    expect(mockGetEnabledServers).toHaveBeenCalledWith('global', expect.any(Array));
  });

  it('given a conversationId, should use it as chatId for store calls', () => {
    setupMocks({ isDesktop: false });

    renderHook(() => useMCPTools({ conversationId: 'conv-42' }));

    expect(mockGetEnabledServers).toHaveBeenCalledWith('conv-42', expect.any(Array));
  });

  it('should expose isServerEnabled callback bound to chatId', () => {
    setupMocks({ isDesktop: false });

    const { result } = renderHook(() => useMCPTools({ conversationId: 'conv-1' }));

    result.current.isServerEnabled('server-x');
    expect(mockIsServerEnabled).toHaveBeenCalledWith('conv-1', 'server-x');
  });

  it('should expose setServerEnabled callback bound to chatId', () => {
    setupMocks({ isDesktop: false });

    const { result } = renderHook(() => useMCPTools({ conversationId: 'conv-1' }));

    result.current.setServerEnabled('server-x', false);
    expect(mockSetServerEnabled).toHaveBeenCalledWith('conv-1', 'server-x', false);
  });

  it('should expose setAllServersEnabled callback bound to chatId and runningServerNames', () => {
    setupMocks({
      isDesktop: true,
      serverStatuses: {
        'server-a': { status: 'running', toolsReady: true },
      },
    });

    const { result } = renderHook(() => useMCPTools({ conversationId: 'conv-1' }));

    result.current.setAllServersEnabled(false);
    expect(mockSetAllServersEnabled).toHaveBeenCalledWith('conv-1', false, ['server-a']);
  });

  it('given no enabled servers, should return empty mcpToolSchemas', () => {
    mockGetEnabledServers.mockReturnValue([]);
    setupMocks({ isDesktop: false });

    const { result } = renderHook(() => useMCPTools({ conversationId: 'conv-1' }));

    expect(result.current.mcpToolSchemas).toEqual([]);
  });

  it('should expose enabledServerCount from store', () => {
    mockGetEnabledServers.mockReturnValue(['server-a', 'server-b']);
    setupMocks({ isDesktop: false });

    const { result } = renderHook(() => useMCPTools({ conversationId: 'conv-1' }));

    expect(result.current.enabledServerCount).toBe(2);
  });

  it('should expose allServersEnabled from store', () => {
    mockAreAllServersEnabled.mockReturnValue(false);
    setupMocks({ isDesktop: false });

    const { result } = renderHook(() => useMCPTools({ conversationId: 'conv-1' }));

    expect(result.current.allServersEnabled).toBe(false);
  });
});

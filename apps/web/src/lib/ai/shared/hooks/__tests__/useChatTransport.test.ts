import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock external dependencies before imports
const mockCreateStreamTrackingFetch = vi.fn(() => vi.fn());

vi.mock('@/lib/ai/core/client', () => ({
  createStreamTrackingFetch: (...args: unknown[]) => mockCreateStreamTrackingFetch(...args),
}));

vi.mock('ai', () => ({
  DefaultChatTransport: class MockDefaultChatTransport {
    api: string;
    fetch: unknown;
    constructor(opts: { api: string; fetch: unknown }) {
      this.api = opts.api;
      this.fetch = opts.fetch;
    }
  },
}));

import { useChatTransport } from '../useChatTransport';

describe('useChatTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given null conversationId, should return null', () => {
    const { result } = renderHook(() => useChatTransport(null, '/api/chat'));

    expect(result.current).toBeNull();
  });

  it('given valid conversationId, should return a transport object', () => {
    const { result } = renderHook(() => useChatTransport('conv-1', '/api/chat'));

    expect(result.current).not.toBeNull();
    expect(mockCreateStreamTrackingFetch).toHaveBeenCalledWith({ chatId: 'conv-1' });
  });

  it('given same conversationId and api on re-render, should return the same transport instance', () => {
    const { result, rerender } = renderHook(
      ({ convId, api }) => useChatTransport(convId, api),
      { initialProps: { convId: 'conv-1' as string | null, api: '/api/chat' } }
    );

    const first = result.current;
    rerender({ convId: 'conv-1', api: '/api/chat' });
    const second = result.current;

    expect(first).toBe(second);
  });

  it('given conversationId changes, should return a new transport instance', () => {
    const { result, rerender } = renderHook(
      ({ convId, api }) => useChatTransport(convId, api),
      { initialProps: { convId: 'conv-1' as string | null, api: '/api/chat' } }
    );

    const first = result.current;
    rerender({ convId: 'conv-2', api: '/api/chat' });
    const second = result.current;

    expect(first).not.toBe(second);
    expect(mockCreateStreamTrackingFetch).toHaveBeenCalledWith({ chatId: 'conv-2' });
  });

  it('given api endpoint changes, should return a new transport instance', () => {
    const { result, rerender } = renderHook(
      ({ convId, api }) => useChatTransport(convId, api),
      { initialProps: { convId: 'conv-1' as string | null, api: '/api/chat' } }
    );

    const first = result.current;
    rerender({ convId: 'conv-1', api: '/api/agent-chat' });
    const second = result.current;

    expect(first).not.toBe(second);
  });

  it('given conversationId goes from valid to null, should return null', () => {
    const { result, rerender } = renderHook(
      ({ convId, api }) => useChatTransport(convId, api),
      { initialProps: { convId: 'conv-1' as string | null, api: '/api/chat' } }
    );

    expect(result.current).not.toBeNull();

    rerender({ convId: null, api: '/api/chat' });
    expect(result.current).toBeNull();
  });

  it('given conversationId goes from null to valid, should return a transport', () => {
    const { result, rerender } = renderHook(
      ({ convId, api }) => useChatTransport(convId, api),
      { initialProps: { convId: null as string | null, api: '/api/chat' } }
    );

    expect(result.current).toBeNull();

    rerender({ convId: 'conv-1', api: '/api/chat' });
    expect(result.current).not.toBeNull();
  });
});

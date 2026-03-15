import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock external dependencies before imports
const mockStartStreaming = vi.fn();
const mockEndStreaming = vi.fn();

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: {
    getState: () => ({
      startStreaming: mockStartStreaming,
      endStreaming: mockEndStreaming,
    }),
  },
}));

import { useStreamingRegistration } from '../useStreamingRegistration';

describe('useStreamingRegistration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given isStreaming true, should call startStreaming with id and metadata', () => {
    const metadata = { pageId: 'p1', conversationId: 'c1', componentName: 'TestChat' };

    renderHook(() => useStreamingRegistration('stream-1', true, metadata));

    expect(mockStartStreaming).toHaveBeenCalledWith('stream-1', metadata);
    expect(mockEndStreaming).not.toHaveBeenCalled();
  });

  it('given isStreaming false, should call endStreaming with id', () => {
    renderHook(() => useStreamingRegistration('stream-1', false));

    expect(mockEndStreaming).toHaveBeenCalledWith('stream-1');
    expect(mockStartStreaming).not.toHaveBeenCalled();
  });

  it('given isStreaming transitions from true to false, should call endStreaming', () => {
    const { rerender } = renderHook(
      ({ id, streaming, meta }: { id: string; streaming: boolean; meta?: Record<string, string> }) =>
        useStreamingRegistration(id, streaming, meta),
      { initialProps: { id: 'stream-1', streaming: true, meta: { pageId: 'p1' } } }
    );

    expect(mockStartStreaming).toHaveBeenCalledTimes(1);
    mockStartStreaming.mockClear();
    mockEndStreaming.mockClear();

    rerender({ id: 'stream-1', streaming: false });

    expect(mockEndStreaming).toHaveBeenCalledWith('stream-1');
  });

  it('given isStreaming transitions from false to true, should call startStreaming', () => {
    const { rerender } = renderHook(
      ({ id, streaming, meta }: { id: string; streaming: boolean; meta?: Record<string, string> }) =>
        useStreamingRegistration(id, streaming, meta),
      { initialProps: { id: 'stream-1', streaming: false } as { id: string; streaming: boolean; meta?: Record<string, string> } }
    );

    expect(mockEndStreaming).toHaveBeenCalledTimes(1);
    mockStartStreaming.mockClear();
    mockEndStreaming.mockClear();

    rerender({ id: 'stream-1', streaming: true, meta: { conversationId: 'c1' } });

    expect(mockStartStreaming).toHaveBeenCalledWith('stream-1', { conversationId: 'c1' });
  });

  it('given unmount while streaming, should call endStreaming for cleanup', () => {
    const { unmount } = renderHook(() =>
      useStreamingRegistration('stream-1', true, { pageId: 'p1' })
    );

    mockEndStreaming.mockClear();

    unmount();

    expect(mockEndStreaming).toHaveBeenCalledWith('stream-1');
  });

  it('given unmount while not streaming, should call endStreaming for cleanup', () => {
    const { unmount } = renderHook(() =>
      useStreamingRegistration('stream-1', false)
    );

    mockEndStreaming.mockClear();

    unmount();

    // The cleanup function always calls endStreaming
    expect(mockEndStreaming).toHaveBeenCalledWith('stream-1');
  });

  it('given id changes, should end the old session and start new', () => {
    const { rerender } = renderHook(
      ({ id, streaming }: { id: string; streaming: boolean }) =>
        useStreamingRegistration(id, streaming),
      { initialProps: { id: 'stream-1', streaming: true } }
    );

    expect(mockStartStreaming).toHaveBeenCalledWith('stream-1', undefined);
    mockStartStreaming.mockClear();
    mockEndStreaming.mockClear();

    rerender({ id: 'stream-2', streaming: true });

    // Cleanup for old id + start for new id
    expect(mockEndStreaming).toHaveBeenCalledWith('stream-1');
    expect(mockStartStreaming).toHaveBeenCalledWith('stream-2', undefined);
  });

  it('given same props on re-render, should not re-register', () => {
    const metadata = { pageId: 'p1', conversationId: 'c1', componentName: 'Chat' };

    const { rerender } = renderHook(
      ({ id, streaming, meta }: { id: string; streaming: boolean; meta?: Record<string, string> }) =>
        useStreamingRegistration(id, streaming, meta),
      { initialProps: { id: 'stream-1', streaming: true, meta: metadata } }
    );

    expect(mockStartStreaming).toHaveBeenCalledTimes(1);
    mockStartStreaming.mockClear();
    mockEndStreaming.mockClear();

    // Re-render with same values (same metadata reference)
    rerender({ id: 'stream-1', streaming: true, meta: metadata });

    // Should not re-trigger since deps haven't changed
    expect(mockStartStreaming).not.toHaveBeenCalled();
  });
});

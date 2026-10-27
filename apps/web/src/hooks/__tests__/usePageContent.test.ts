import { describe, it, vi, beforeEach, afterEach, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { assert } from './riteway';
import { isRichContentEmpty, isDirty, usePageContent } from '../usePageContent';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: {
    getState: vi.fn(() => ({
      startEditing: vi.fn(),
      endEditing: vi.fn(),
    })),
  },
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
const mockFetch = fetchWithAuth as ReturnType<typeof vi.fn>;

// ─── pure functions ───────────────────────────────────────────────────────────

describe('isRichContentEmpty', () => {
  it('null content', () => {
    assert({
      given: 'null content',
      should: 'be considered empty',
      actual: isRichContentEmpty(null),
      expected: true,
    });
  });

  it('empty string', () => {
    assert({
      given: 'an empty string',
      should: 'be considered empty',
      actual: isRichContentEmpty(''),
      expected: true,
    });
  });

  it('empty paragraph tag', () => {
    assert({
      given: 'an empty paragraph tag',
      should: 'be considered empty',
      actual: isRichContentEmpty('<p></p>'),
      expected: true,
    });
  });

  it('paragraph with only a line break', () => {
    assert({
      given: 'a paragraph containing only a br element',
      should: 'be considered empty',
      actual: isRichContentEmpty('<p><br></p>'),
      expected: true,
    });
  });

  it('paragraph with text', () => {
    assert({
      given: 'a paragraph with text content',
      should: 'not be considered empty',
      actual: isRichContentEmpty('<p>hello</p>'),
      expected: false,
    });
  });

  it('whitespace only', () => {
    assert({
      given: 'only whitespace after stripping tags',
      should: 'be considered empty',
      actual: isRichContentEmpty('<p>   </p>'),
      expected: true,
    });
  });
});

// ─── isDirty ─────────────────────────────────────────────────────────────────

describe('isDirty', () => {
  it('null is not dirty', () => {
    assert({
      given: 'null pending content',
      should: 'not be dirty',
      actual: isDirty(null),
      expected: false,
    });
  });

  it('empty string is dirty', () => {
    assert({
      given: 'an empty string queued as a write',
      should: 'be dirty since a write is pending',
      actual: isDirty(''),
      expected: true,
    });
  });

  it('non-empty string is dirty', () => {
    assert({
      given: 'a non-empty string queued as a write',
      should: 'be dirty',
      actual: isDirty('<p>content</p>'),
      expected: true,
    });
  });
});

// ─── hook ─────────────────────────────────────────────────────────────────────

describe('usePageContent', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('null pageId skips fetch', () => {
    const { result } = renderHook(() => usePageContent({ pageId: null }));

    assert({
      given: 'a null pageId',
      should: 'return null content without fetching',
      actual: result.current.content,
      expected: null,
    });

    assert({
      given: 'a null pageId',
      should: 'not call the network',
      actual: mockFetch.mock.calls.length,
      expected: 0,
    });
  });

  it('disabled skips fetch', () => {
    const { result } = renderHook(() =>
      usePageContent({ pageId: 'page-1', enabled: false })
    );

    assert({
      given: 'enabled is false',
      should: 'not fetch and return null content',
      actual: result.current.content,
      expected: null,
    });

    assert({
      given: 'enabled is false',
      should: 'not call the network',
      actual: mockFetch.mock.calls.length,
      expected: 0,
    });
  });

  it('fetches content when enabled with a pageId', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: '<p>task description</p>' }),
    });

    const { result } = renderHook(() => usePageContent({ pageId: 'page-1' }));

    await waitFor(() => {
      expect(result.current.content).toEqual('<p>task description</p>');
    });

    assert({
      given: 'a valid pageId and enabled',
      should: 'return the fetched page content',
      actual: result.current.content,
      expected: '<p>task description</p>',
    });
  });

  it('returns null content when fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));

    const { result } = renderHook(() => usePageContent({ pageId: 'page-1' }));

    await waitFor(() => {
      expect(result.current.isLoading).toEqual(false);
    });

    assert({
      given: 'a network error during fetch',
      should: 'return null content without throwing',
      actual: result.current.content,
      expected: null,
    });
  });

  it('initialContent seeds state without fetching', () => {
    const { result } = renderHook(() =>
      usePageContent({ pageId: 'page-1', initialContent: '<p>seeded</p>' })
    );

    assert({
      given: 'initialContent is provided',
      should: 'return seeded content immediately',
      actual: result.current.content,
      expected: '<p>seeded</p>',
    });

    assert({
      given: 'initialContent is provided',
      should: 'not call the network',
      actual: mockFetch.mock.calls.length,
      expected: 0,
    });
  });

  it('initialContent null seeds state without fetching', () => {
    const { result } = renderHook(() =>
      usePageContent({ pageId: 'page-1', initialContent: null })
    );

    assert({
      given: 'initialContent is explicitly null',
      should: 'return null content without fetching',
      actual: result.current.content,
      expected: null,
    });

    assert({
      given: 'initialContent is explicitly null',
      should: 'not call the network on first render',
      actual: mockFetch.mock.calls.length,
      expected: 0,
    });
  });
});

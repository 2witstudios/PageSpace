/**
 * usePublishStatusStore Tests
 *
 * This store exists specifically to fix a cross-component staleness bug: the
 * header's PublishControls and the canvas Settings tab's Publish/Appearance
 * categories used to each independently fetch publish status once on mount,
 * so publishing/unpublishing from one left the others showing stale data
 * until they remounted. These tests verify the sharing mechanism itself
 * (fetch/cache/dedupe/update-visible-to-all-readers), not any one component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { usePublishStatusStore, EMPTY_PUBLISH_STATUS } from '../usePublishStatusStore';

const mockFetchWithAuth = vi.mocked(fetchWithAuth);

const makeResponse = ({ status = 200, body = {} }: { status?: number; body?: unknown } = {}) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

describe('usePublishStatusStore', () => {
  beforeEach(() => {
    usePublishStatusStore.setState({ statuses: new Map(), inFlight: new Map() });
    mockFetchWithAuth.mockReset();
  });

  it('given a successful published response, fetchStatus should cache it under the pageId', async () => {
    mockFetchWithAuth.mockResolvedValue(makeResponse({
      body: { published: true, url: 'https://acme.pagespace.site/welcome', available: true, isStale: false, themeBridgeEnabled: false },
    }));

    await usePublishStatusStore.getState().fetchStatus('page-1');

    const status = usePublishStatusStore.getState().statuses.get('page-1');
    expect(status).toMatchObject({
      published: true,
      url: 'https://acme.pagespace.site/welcome',
      available: true,
      settings: expect.objectContaining({ themeBridgeEnabled: false }),
    });
  });

  it('given concurrent fetchStatus calls for the same pageId, should only issue one request', async () => {
    let resolveFetch: (r: Response) => void;
    mockFetchWithAuth.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

    const first = usePublishStatusStore.getState().fetchStatus('page-1');
    const second = usePublishStatusStore.getState().fetchStatus('page-1');

    resolveFetch!(makeResponse({ body: { published: false, available: true } }));
    await Promise.all([first, second]);

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('given a 403, fetchStatus should report unavailable without a load error (permission, not failure)', async () => {
    mockFetchWithAuth.mockResolvedValue(makeResponse({ status: 403 }));

    await usePublishStatusStore.getState().fetchStatus('page-1');

    expect(usePublishStatusStore.getState().statuses.get('page-1')).toMatchObject({
      available: false,
      hasLoadError: false,
    });
  });

  it('given a 500, fetchStatus should report a load error', async () => {
    mockFetchWithAuth.mockResolvedValue(makeResponse({ status: 500 }));

    await usePublishStatusStore.getState().fetchStatus('page-1');

    expect(usePublishStatusStore.getState().statuses.get('page-1')).toMatchObject({
      available: false,
      hasLoadError: true,
    });
  });

  it('given a network error, fetchStatus should report a load error', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('network down'));

    await usePublishStatusStore.getState().fetchStatus('page-1');

    expect(usePublishStatusStore.getState().statuses.get('page-1')).toMatchObject({ hasLoadError: true });
  });

  it('given setStatus for one pageId, should leave other pageIds untouched (the actual sharing mechanism)', () => {
    usePublishStatusStore.getState().setStatus('page-1', { ...EMPTY_PUBLISH_STATUS, published: true });
    usePublishStatusStore.getState().setStatus('page-2', { ...EMPTY_PUBLISH_STATUS, published: false });

    expect(usePublishStatusStore.getState().statuses.get('page-1')?.published).toBe(true);
    expect(usePublishStatusStore.getState().statuses.get('page-2')?.published).toBe(false);
  });

  it('given setStatus, every reader of that pageId sees the update — the fix for the cross-component staleness bug', () => {
    // Simulates two independent consumers (e.g. the header and a canvas
    // Settings category) reading the same store slice.
    usePublishStatusStore.getState().setStatus('page-1', { ...EMPTY_PUBLISH_STATUS, published: false });
    const readerA = () => usePublishStatusStore.getState().statuses.get('page-1');
    const readerB = () => usePublishStatusStore.getState().statuses.get('page-1');

    expect(readerA()?.published).toBe(false);
    expect(readerB()?.published).toBe(false);

    // One consumer (e.g. the header) publishes the page.
    usePublishStatusStore.getState().setStatus('page-1', { ...EMPTY_PUBLISH_STATUS, published: true, url: 'https://x.pagespace.site/y' });

    // The other consumer's next read reflects it immediately — no separate
    // fetch, no stale mount-time snapshot.
    expect(readerB()?.published).toBe(true);
    expect(readerB()?.url).toBe('https://x.pagespace.site/y');
  });
});

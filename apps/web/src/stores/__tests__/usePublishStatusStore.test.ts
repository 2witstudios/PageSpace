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
    usePublishStatusStore.setState({ statuses: new Map(), inFlight: new Map(), generations: new Map() });
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

  it('given an already-cached good status, a subsequent 500 should preserve it (not wipe it to empty)', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(makeResponse({
      body: { published: true, canEdit: true, url: 'https://acme.pagespace.site/welcome', available: true },
    }));
    await usePublishStatusStore.getState().fetchStatus('page-1');

    // A later refetch (e.g. re-entering the Settings tab's Publish category)
    // hits a transient failure — every OTHER shared consumer (the header)
    // must not see this page suddenly become unpublished/unavailable.
    mockFetchWithAuth.mockResolvedValueOnce(makeResponse({ status: 500 }));
    await usePublishStatusStore.getState().fetchStatus('page-1');

    expect(usePublishStatusStore.getState().statuses.get('page-1')).toMatchObject({
      published: true,
      available: true,
      url: 'https://acme.pagespace.site/welcome',
      hasLoadError: true,
    });
  });

  it('given an already-cached good status, a subsequent 403 should reset it (a definitive signal, not a failure)', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(makeResponse({
      body: { published: true, canEdit: true, url: 'https://acme.pagespace.site/welcome', available: true },
    }));
    await usePublishStatusStore.getState().fetchStatus('page-1');

    mockFetchWithAuth.mockResolvedValueOnce(makeResponse({ status: 403 }));
    await usePublishStatusStore.getState().fetchStatus('page-1');

    expect(usePublishStatusStore.getState().statuses.get('page-1')).toMatchObject({
      available: false,
      hasLoadError: false,
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

  it('given a mutation commits while an older fetch is still in flight, the fetch\'s stale response must not overwrite it', async () => {
    // Regression test for a Codex-flagged race: mounting a settings category
    // starts a GET while the header stays actionable. If the slower GET
    // (reading the page as still published) resolves AFTER a faster
    // Unpublish DELETE has already committed the newer "unpublished" state,
    // applying the GET's response would resurrect a URL that was just
    // successfully unpublished.
    let resolveFetch: (r: Response) => void;
    mockFetchWithAuth.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));

    const slowFetch = usePublishStatusStore.getState().fetchStatus('page-1');

    // The mutation (e.g. PublishControls' handleUnpublish) commits directly
    // via setStatus, the same as the real code path — no fetchStatus call.
    usePublishStatusStore.getState().setStatus('page-1', {
      ...EMPTY_PUBLISH_STATUS, published: false, url: null, available: true, canEdit: true,
    });

    // The slow GET now resolves with what it read before the unpublish.
    resolveFetch!(makeResponse({
      body: { published: true, canEdit: true, url: 'https://acme.pagespace.site/welcome', available: true },
    }));
    await slowFetch;

    expect(usePublishStatusStore.getState().statuses.get('page-1')).toMatchObject({
      published: false,
      url: null,
    });
  });

  it('given a fetchStatus already in flight, a force:true call should issue a fresh request rather than reuse it', async () => {
    // Regression test for a Codex-flagged bug: CanvasHomePageSettingsSection
    // PATCHes the drive's homePageId (which changes this page's published
    // URL — root vs slug) then calls fetchStatus to refresh the header. If
    // another consumer's mount-time fetchStatus was still in flight (having
    // read the row *before* that PATCH), the plain in-flight dedup would
    // hand back that same stale promise instead of reading fresh — so the
    // header would keep showing/copying the pre-change URL.
    let resolveSlow: (r: Response) => void;
    let resolveForced: (r: Response) => void;
    mockFetchWithAuth
      .mockReturnValueOnce(new Promise((resolve) => { resolveSlow = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveForced = resolve; }));

    const slowFetch = usePublishStatusStore.getState().fetchStatus('page-1');
    const forcedFetch = usePublishStatusStore.getState().fetchStatus('page-1', { force: true });

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);

    // The forced (post-mutation) read resolves first with the fresh URL.
    resolveForced!(makeResponse({
      body: { published: true, canEdit: true, url: 'https://acme.pagespace.site/new-home', available: true },
    }));
    await forcedFetch;

    // The older, slower fetch then resolves with what it read before the
    // mutation — its result must be discarded, not overwrite the fresh one.
    resolveSlow!(makeResponse({
      body: { published: true, canEdit: true, url: 'https://acme.pagespace.site/welcome', available: true },
    }));
    await slowFetch;

    expect(usePublishStatusStore.getState().statuses.get('page-1')).toMatchObject({
      url: 'https://acme.pagespace.site/new-home',
    });
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

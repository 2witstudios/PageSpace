import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/links/page-url-parser', () => ({
  extractPageUrls: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchLinkPreviews } from '../useLinkPreview';
import { extractPageUrls } from '@pagespace/lib/links/page-url-parser';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const mockExtract = extractPageUrls as ReturnType<typeof vi.fn>;
const mockFetch = fetchWithAuth as ReturnType<typeof vi.fn>;

function makeOkResponse(data: unknown) {
  return { ok: true, json: async () => data } as unknown as Response;
}

function makeNotFoundResponse() {
  return { ok: false, status: 404 } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchLinkPreviews', () => {
  it('calls fetchWithAuth once per unique pageId', async () => {
    mockExtract.mockReturnValue([
      { pageId: 'p1', driveId: 'd1' },
      { pageId: 'p2', driveId: 'd1' },
    ]);
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'p1', title: 'Page 1', type: 'DOCUMENT', driveId: 'd1', driveName: 'Drive' }));

    await fetchLinkPreviews('some content with two links');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates: same pageId twice → only one fetch call', async () => {
    mockExtract.mockReturnValue([
      { pageId: 'p1', driveId: 'd1' },
      { pageId: 'p1', driveId: 'd1' },
    ]);
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'p1', title: 'Page 1', type: 'DOCUMENT', driveId: 'd1', driveName: 'Drive' }));

    await fetchLinkPreviews('duplicate link content');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty array and makes no fetch when no internal URLs', async () => {
    mockExtract.mockReturnValue([]);

    const result = await fetchLinkPreviews('hello world no links');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('returns empty array and makes no fetch for empty content', async () => {
    mockExtract.mockReturnValue([]);

    const result = await fetchLinkPreviews('');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('silently skips 404 responses — excludes them from result', async () => {
    mockExtract.mockReturnValue([
      { pageId: 'p1', driveId: 'd1' },
      { pageId: 'p2', driveId: 'd1' },
    ]);
    mockFetch
      .mockResolvedValueOnce(makeNotFoundResponse())
      .mockResolvedValueOnce(makeOkResponse({ id: 'p2', title: 'Page 2', type: 'CHANNEL', driveId: 'd1', driveName: 'Drive' }));

    const result = await fetchLinkPreviews('two links one 404');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p2');
  });

  it('returns metadata for successful fetches', async () => {
    const metadata = { id: 'p1', title: 'My Page', type: 'DOCUMENT', driveId: 'd1', driveName: 'My Drive', snippet: 'Hello' };
    mockExtract.mockReturnValue([{ pageId: 'p1', driveId: 'd1' }]);
    mockFetch.mockResolvedValue(makeOkResponse(metadata));

    const result = await fetchLinkPreviews('content with one link');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(metadata);
  });

  it('caps fetches at 5 when message contains more than 5 unique page links', async () => {
    const manyUrls = Array.from({ length: 8 }, (_, i) => ({ pageId: `p${i}`, driveId: 'd1' }));
    mockExtract.mockReturnValue(manyUrls);
    mockFetch.mockResolvedValue(
      makeOkResponse({ id: 'px', title: 'Page', type: 'DOCUMENT', driveId: 'd1', driveName: 'Drive' }),
    );

    await fetchLinkPreviews('message with 8 unique links');

    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});

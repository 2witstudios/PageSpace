import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCreateUploadServiceToken = vi.fn();
const mockCreatePageServiceToken = vi.fn();
const mockCreateSystemFileDeleteToken = vi.fn();
vi.mock('@pagespace/lib/services/validated-service-token', () => ({
  createUploadServiceToken: (...args: unknown[]) => mockCreateUploadServiceToken(...args),
  createPageServiceToken: (...args: unknown[]) => mockCreatePageServiceToken(...args),
  createSystemFileDeleteToken: (...args: unknown[]) => mockCreateSystemFileDeleteToken(...args),
}));

import { storeOriginalViaProcessor, fetchOriginalFromProcessor, reclaimOrphanedOriginal } from '../processor-effects';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';

const ACTOR = { userId: 'u1' } as unknown as AccessActor;
const BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff]);
const HASH = 'a'.repeat(64);

describe('storeOriginalViaProcessor', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockCreateUploadServiceToken.mockReset();
    mockCreateUploadServiceToken.mockResolvedValue({ token: 'tok' });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const call = () =>
    storeOriginalViaProcessor({
      actor: ACTOR,
      driveId: 'd1',
      parentId: 'folder1',
      pageId: 'newpage',
      contentHash: HASH,
      buffer: BYTES,
      originalName: 'scan résumé.pdf',
    });

  it('mints a files:write token bound to the NEW page, checked against the parent', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await call();
    expect(mockCreateUploadServiceToken).toHaveBeenCalledWith({
      actor: ACTOR,
      driveId: 'd1',
      pageId: 'newpage',
      parentId: 'folder1',
      scopes: ['files:write'],
    });
  });

  it('POSTs the raw bytes with the declared hash and an encoded name to /api/originals/:pageId', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await call();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toMatch(/\/api\/originals\/newpage$/);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/octet-stream',
      'X-Content-Hash': HASH,
      'X-Original-Name': encodeURIComponent('scan résumé.pdf'),
    });
    expect(Buffer.compare(Buffer.from(init.body as Uint8Array), BYTES)).toBe(0);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('given a refusal, should throw with the processor reason so nothing is committed', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, reason: 'hash_mismatch' }), { status: 422 }));
    await expect(call()).rejects.toThrow(/hash_mismatch/);
  });
});

describe('fetchOriginalFromProcessor', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockCreatePageServiceToken.mockReset();
    mockCreatePageServiceToken.mockResolvedValue({ token: 'read-tok' });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const call = (over: { filePath?: string; maxBytes?: number } = {}) =>
    fetchOriginalFromProcessor({
      actor: ACTOR,
      pageId: 'scan',
      filePath: over.filePath ?? HASH,
      maxBytes: over.maxBytes ?? 1024,
    });

  it('reads /cache/:hash/original with a page-bound files:read token and returns the exact bytes', async () => {
    fetchMock.mockResolvedValue(new Response(BYTES, { status: 200, headers: { 'Content-Length': String(BYTES.length) } }));
    const result = await call();
    expect(mockCreatePageServiceToken).toHaveBeenCalledWith(ACTOR, 'scan', ['files:read'], '5m');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toMatch(new RegExp(`/cache/${HASH}/original$`));
    expect(init.headers).toMatchObject({ Authorization: 'Bearer read-tok' });
    expect(result.success).toBe(true);
    if (result.success) expect(Buffer.from(result.bytes).equals(BYTES)).toBe(true);
  });

  it('accepts a legacy files/{hash}/original storage path', async () => {
    fetchMock.mockResolvedValue(new Response(BYTES, { status: 200 }));
    await call({ filePath: `files/${HASH}/original` });
    expect((fetchMock.mock.calls[0] as [string])[0]).toMatch(new RegExp(`/cache/${HASH}/original$`));
  });

  it('given a declared length over the cap, should refuse without reading the body', async () => {
    const body = { cancel: vi.fn(async () => {}) };
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers({ 'Content-Length': '4096' }), body, arrayBuffer: vi.fn() });
    const result = await call({ maxBytes: 1024 });
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toContain('1024');
    expect(body.cancel).toHaveBeenCalled();
  });

  it('given a body over the cap with no declared length, should still refuse', async () => {
    fetchMock.mockResolvedValue(new Response(Buffer.alloc(2048), { status: 200 }));
    const result = await call({ maxBytes: 1024 });
    expect(result.success).toBe(false);
  });

  it('given a removed file (410), should say so', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 410 }));
    const result = await call();
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toMatch(/removed/i);
  });

  it('given a processor error, should report it rather than throw', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const result = await call();
    expect(result).toMatchObject({ success: false });
  });
});

describe('review #3016: stored flag, deadline, reclaim', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    mockCreateUploadServiceToken.mockReset();
    mockCreateUploadServiceToken.mockResolvedValue({ token: 'tok' });
    mockCreatePageServiceToken.mockReset();
    mockCreatePageServiceToken.mockResolvedValue({ token: 'read-tok' });
    mockCreateSystemFileDeleteToken.mockReset();
    mockCreateSystemFileDeleteToken.mockResolvedValue({ token: 'del-tok' });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const store = (deadlineAt?: number) =>
    storeOriginalViaProcessor({
      actor: ACTOR,
      driveId: 'd1',
      parentId: 'folder1',
      pageId: 'newpage',
      contentHash: HASH,
      buffer: BYTES,
      originalName: 'a.pdf',
      deadlineAt,
    });

  it('reports whether the processor wrote NEW bytes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, stored: true }), { status: 200 }));
    expect(await store()).toEqual({ stored: true });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, stored: false }), { status: 200 }));
    expect(await store()).toEqual({ stored: false });
  });

  it('given a deadline already past, should refuse without sending the bytes', async () => {
    await expect(store(Date.now() - 1)).rejects.toThrow(/time/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('given a deadline already past, a fetch refuses without asking the processor', async () => {
    const result = await fetchOriginalFromProcessor({ actor: ACTOR, pageId: 'scan', filePath: HASH, maxBytes: 1024, deadlineAt: Date.now() - 1 });
    expect(result).toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a timed-out fetch says it timed out', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    const result = await fetchOriginalFromProcessor({ actor: ACTOR, pageId: 'scan', filePath: HASH, maxBytes: 1024, deadlineAt: Date.now() + 1_000 });
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toMatch(/did not finish in time/);
  });

  it('reclaims an orphaned original through the processor delete, with a system file-bound token', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await reclaimOrphanedOriginal(HASH);
    expect(mockCreateSystemFileDeleteToken).toHaveBeenCalledWith({ contentHash: HASH, expiresIn: '30s' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toMatch(new RegExp(`/api/files/${HASH}$`));
    expect(init.method).toBe('DELETE');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer del-tok' });
  });

  it('a reclaim the processor refuses (still referenced, held) throws, for the caller to log', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 409 }));
    await expect(reclaimOrphanedOriginal(HASH)).rejects.toThrow(/409/);
  });
});

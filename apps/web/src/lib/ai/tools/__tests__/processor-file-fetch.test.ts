import { describe, it, expect, vi } from 'vitest';
import { assert } from '@/test/riteway';
import { createProcessorCacheFetcher, FileAccessDeniedError } from '../processor-file-fetch';

const HASH = 'a'.repeat(64);

const okResponse = (bytes: Buffer, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Length': String(bytes.length), ...headers } });

const setup = (overrides: Partial<Parameters<typeof createProcessorCacheFetcher>[0]> = {}) => {
  const canView = vi.fn(async () => true);
  const mintToken = vi.fn(async () => 'svc-token');
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okResponse(Buffer.from('bytes')));
  const fetcher = createProcessorCacheFetcher({
    canView,
    mintToken,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    processorUrl: 'http://processor:3003',
    ...overrides,
  });
  return { fetcher, canView, mintToken, fetchImpl };
};

describe('createProcessorCacheFetcher', () => {
  it('fetches a cache preset from the processor with a page service token', async () => {
    const { fetcher, fetchImpl } = setup();

    const bytes = await fetcher(HASH, 'pdf-page-3');

    assert({
      given: 'a viewable page and a cached preset',
      should: 'return the bytes the processor served (decrypted there)',
      actual: bytes?.toString(),
      expected: 'bytes',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    assert({
      given: 'a preset fetch',
      should: "call the processor's /cache/:hash/:preset route",
      actual: String(url),
      expected: `http://processor:3003/cache/${HASH}/pdf-page-3`,
    });
    assert({
      given: 'a preset fetch',
      should: 'authenticate with the minted service token',
      actual: (init?.headers as Record<string, string>).Authorization,
      expected: 'Bearer svc-token',
    });
  });

  it('checks permission before minting a token, and refuses without one', async () => {
    const { fetcher, mintToken, fetchImpl } = setup({ canView: vi.fn(async () => false) });

    await expect(fetcher(HASH, 'ai-vision')).rejects.toBeInstanceOf(FileAccessDeniedError);
    assert({
      given: 'an actor who cannot view the page',
      should: 'mint no token and make no request',
      actual: { minted: mintToken.mock.calls.length, fetched: fetchImpl.mock.calls.length },
      expected: { minted: 0, fetched: 0 },
    });
  });

  it('checks permission and mints the token once across many preset fetches', async () => {
    const { fetcher, canView, mintToken } = setup();

    await Promise.all([fetcher(HASH, 'pdf-page-1'), fetcher(HASH, 'pdf-page-2'), fetcher(HASH, 'original')]);

    assert({
      given: 'three preset fetches for one page',
      should: 'run the permission check and mint the token once',
      actual: { checks: canView.mock.calls.length, minted: mintToken.mock.calls.length },
      expected: { checks: 1, minted: 1 },
    });
  });

  it('returns null for a preset the processor does not have', async () => {
    const { fetcher } = setup({ fetchImpl: vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch });
    assert({
      given: 'a 404 from the processor',
      should: 'return null so the caller can fall back',
      actual: await fetcher(HASH, 'ai-vision'),
      expected: null,
    });
  });

  it('returns null for a removed (taken-down) file', async () => {
    const { fetcher } = setup({ fetchImpl: vi.fn(async () => new Response('gone', { status: 410 })) as unknown as typeof fetch });
    assert({
      given: 'a 410 from the processor',
      should: 'return null',
      actual: await fetcher(HASH, 'ai-vision'),
      expected: null,
    });
  });

  it('throws on any other processor failure', async () => {
    const { fetcher } = setup({ fetchImpl: vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch });
    await expect(fetcher(HASH, 'ai-vision')).rejects.toThrow(/500/);
  });

  it('returns null when the declared size is over the cap, without reading the body', async () => {
    const big = Buffer.alloc(10);
    const { fetcher } = setup({ fetchImpl: vi.fn(async () => okResponse(big)) as unknown as typeof fetch });
    assert({
      given: 'a 10-byte object and a 5-byte cap',
      should: 'return null',
      actual: await fetcher(HASH, 'original', { maxBytes: 5 }),
      expected: null,
    });
  });

  it('returns null when the body is over the cap even if no length was declared', async () => {
    const response = new Response(new Uint8Array(Buffer.alloc(10)), { status: 200 });
    response.headers.delete('Content-Length');
    const { fetcher } = setup({ fetchImpl: vi.fn(async () => response) as unknown as typeof fetch });
    assert({
      given: 'a 10-byte body with no Content-Length and a 5-byte cap',
      should: 'return null',
      actual: await fetcher(HASH, 'original', { maxBytes: 5 }),
      expected: null,
    });
  });

  it('rejects a malformed content hash or preset before any request', async () => {
    const { fetcher, fetchImpl } = setup();
    await expect(fetcher('../etc', 'ai-vision')).rejects.toThrow(/content hash/i);
    await expect(fetcher(HASH, '../original')).rejects.toThrow(/preset/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

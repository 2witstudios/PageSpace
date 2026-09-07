/**
 * The web tier's ONLY listener source: a signed, bounded ask of the realtime
 * tier that answers null for every failure — never a probe, never an error
 * the user sees.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { realtime: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn((body: string) => ({ 'Content-Type': 'application/json', 'X-Broadcast-Signature': `sig:${body.length}` })),
}));
vi.mock('@pagespace/lib/services/sandbox/preview/dev-preview-env', () => ({ isDevPreviewConfigured: vi.fn(() => true) }));

import { readDevPreviewListeners } from '../listeners-source';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { readDevPreviewUserAction } from '../user-action-body';

const HOLDER = { kind: 'env', id: 'env1' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDevPreviewConfigured).mockReturnValue(true);
  process.env.INTERNAL_REALTIME_URL = 'http://realtime.internal:3001';
});
afterEach(() => {
  delete process.env.INTERNAL_REALTIME_URL;
});

describe('readDevPreviewListeners', () => {
  it('POSTs the holder, signed, to the listeners route with redirect: error and a timeout, and returns the cleaned snapshot', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ detection: 'watching', listeners: [{ port: 5173, pid: 3 }, { port: 8080 }, { port: 'x' }, { port: 1, pid: 'y' }] })));
    const result = await readDevPreviewListeners(HOLDER, fetchImpl as unknown as typeof fetch);
    // Parsed with the watch channel's own reader: a non-integer pid is dropped, the port is kept; a non-integer port is dropped.
    expect(result).toEqual({ detection: 'watching', listeners: [{ port: 5173, pid: 3 }, { port: 8080 }, { port: 1 }] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://realtime.internal:3001/api/dev-preview/listeners');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ holder: HOLDER }));
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['X-Broadcast-Signature']).toMatch(/^sig:/);
  });

  it('answers "unknown, and nothing is watching" for every failure: a non-array, a bogus detection, a non-2xx, a network failure (logged), a dark feature, no realtime URL', async () => {
    const UNKNOWN = { detection: 'unavailable', listeners: null };
    // A null snapshot from a WATCHING realtime keeps that fact: the ports are
    // unknown, but detection IS running — a different sentence for the UI.
    expect(await readDevPreviewListeners(HOLDER, (async () => new Response(JSON.stringify({ detection: 'watching', listeners: null }))) as unknown as typeof fetch)).toEqual({ detection: 'watching', listeners: null });
    expect(await readDevPreviewListeners(HOLDER, (async () => new Response(JSON.stringify({ listeners: 'nope' }))) as unknown as typeof fetch)).toEqual(UNKNOWN);
    expect(await readDevPreviewListeners(HOLDER, (async () => new Response(JSON.stringify({ detection: 'bogus', listeners: [] }))) as unknown as typeof fetch)).toEqual({ detection: 'unavailable', listeners: [] });
    expect(await readDevPreviewListeners(HOLDER, (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch)).toEqual(UNKNOWN);
    expect(await readDevPreviewListeners(HOLDER, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch)).toEqual(UNKNOWN);
    expect(loggers.realtime.warn).toHaveBeenCalledWith('dev-preview: listeners read failed', expect.objectContaining({ error: 'ECONNREFUSED' }));

    const fetchImpl = vi.fn();
    vi.mocked(isDevPreviewConfigured).mockReturnValueOnce(false);
    expect(await readDevPreviewListeners(HOLDER, fetchImpl as unknown as typeof fetch)).toEqual(UNKNOWN);
    delete process.env.INTERNAL_REALTIME_URL;
    expect(await readDevPreviewListeners(HOLDER, fetchImpl as unknown as typeof fetch)).toEqual(UNKNOWN);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('readDevPreviewUserAction', () => {
  it('accepts exactly stop / resume', () => {
    expect(readDevPreviewUserAction({ action: 'stop' })).toBe('stop');
    expect(readDevPreviewUserAction({ action: 'resume' })).toBe('resume');
    for (const bad of [{ action: 'start' }, {}, null, 'stop', 7, { action: 1 }]) expect(readDevPreviewUserAction(bad)).toBeNull();
  });
});

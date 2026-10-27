/**
 * The ONE signed web→realtime envelope: signature, no-redirect, timeout, and
 * "not even a request" when the feature is dark or realtime is unset — shared
 * by the watch trigger and the listeners read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { realtime: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } }));
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn((body: string) => ({ 'Content-Type': 'application/json', 'X-Broadcast-Signature': `sig:${body.length}` })),
}));
vi.mock('@pagespace/lib/services/sandbox/preview/dev-preview-env', () => ({ isDevPreviewConfigured: vi.fn(() => true) }));

import { postSignedDevPreviewCall } from '../realtime-call';
import { requestDevPreviewWatch } from '../detection-trigger';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { loggers } from '@pagespace/lib/logging/logger-config';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDevPreviewConfigured).mockReturnValue(true);
  process.env.INTERNAL_REALTIME_URL = 'http://realtime.internal:3001';
});
afterEach(() => {
  delete process.env.INTERNAL_REALTIME_URL;
});

describe('postSignedDevPreviewCall', () => {
  it('POSTs the body, signed, with redirect: error and a bounded signal', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    await postSignedDevPreviewCall('/api/dev-preview/watch', '{"holder":{}}', { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://realtime.internal:3001/api/dev-preview/watch');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['X-Broadcast-Signature']).toMatch(/^sig:/);
  });

  it('makes no request at all when dark or when realtime is unset', () => {
    const fetchImpl = vi.fn();
    vi.mocked(isDevPreviewConfigured).mockReturnValueOnce(false);
    expect(postSignedDevPreviewCall('/api/dev-preview/watch', '{}', { timeoutMs: 1, fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
    delete process.env.INTERNAL_REALTIME_URL;
    expect(postSignedDevPreviewCall('/api/dev-preview/watch', '{}', { timeoutMs: 1, fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('requestDevPreviewWatch', () => {
  it('fires the signed trigger with only the holder and swallows (logs) a failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    requestDevPreviewWatch({ holder: { kind: 'env', id: 'e1' } }, fetchImpl as unknown as typeof fetch);
    await new Promise((r) => setTimeout(r, 0));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://realtime.internal:3001/api/dev-preview/watch');
    expect(init.body).toBe(JSON.stringify({ holder: { kind: 'env', id: 'e1' } }));
    expect(loggers.realtime.warn).toHaveBeenCalledWith('dev-preview: watch trigger failed', expect.objectContaining({ error: 'ECONNREFUSED' }));
  });

  it('is a no-op when dark', () => {
    vi.mocked(isDevPreviewConfigured).mockReturnValueOnce(false);
    const fetchImpl = vi.fn();
    requestDevPreviewWatch({ holder: { kind: 'env', id: 'e1' } }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

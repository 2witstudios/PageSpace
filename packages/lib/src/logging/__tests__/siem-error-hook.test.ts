import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  setSiemErrorHook,
  getSiemErrorHook,
  fireSiemErrorHook,
  buildWebhookSiemErrorHook,
  type SiemErrorPayload,
} from '../siem-error-hook';

describe('fireSiemErrorHook', () => {
  afterEach(() => {
    setSiemErrorHook(null);
  });

  it('given no hook registered, should not throw', () => {
    setSiemErrorHook(null);
    expect(() =>
      fireSiemErrorHook({ level: 'ERROR', message: 'boom', timestamp: new Date().toISOString(), hostname: 'h', pid: 1 })
    ).not.toThrow();
  });

  it('given a hook is registered and fireSiemErrorHook called, should invoke the hook with the payload', () => {
    const hook = vi.fn();
    setSiemErrorHook(hook);
    const payload: SiemErrorPayload = {
      level: 'ERROR',
      message: 'test error',
      timestamp: '2026-04-22T00:00:00.000Z',
      hostname: 'test-host',
      pid: 42,
    };
    fireSiemErrorHook(payload);
    expect(hook).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledWith(payload);
  });

  it('given a hook is registered and fireSiemErrorHook called with FATAL level, should invoke the hook', () => {
    const hook = vi.fn();
    setSiemErrorHook(hook);
    fireSiemErrorHook({ level: 'FATAL', message: 'fatal crash', timestamp: new Date().toISOString(), hostname: 'h', pid: 1 });
    expect(hook).toHaveBeenCalledOnce();
  });

  it('given the hook throws, should not propagate — logging path must survive', () => {
    setSiemErrorHook(() => { throw new Error('hook exploded'); });
    expect(() =>
      fireSiemErrorHook({ level: 'ERROR', message: 'x', timestamp: new Date().toISOString(), hostname: 'h', pid: 1 })
    ).not.toThrow();
  });

  it('given getSiemErrorHook called after setSiemErrorHook, should return the registered hook', () => {
    const hook = vi.fn();
    setSiemErrorHook(hook);
    expect(getSiemErrorHook()).toBe(hook);
  });
});

describe('buildWebhookSiemErrorHook', () => {
  afterEach(() => {
    setSiemErrorHook(null);
    vi.restoreAllMocks();
  });

  it('given a webhook URL and error payload, should POST to the webhook', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const hook = buildWebhookSiemErrorHook('https://siem.example.com/ingest', 'secret123');
    hook({ level: 'ERROR', message: 'oops', timestamp: '2026-04-22T00:00:00.000Z', hostname: 'web-1', pid: 99 });

    // fire-and-forget — flush microtask queue
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://siem.example.com/ingest');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['X-PageSpace-Signature']).toBeTruthy();
    const body = JSON.parse(opts.body);
    expect(body.level).toBe('ERROR');
    expect(body.message).toBe('oops');
  });

  it('given the webhook fetch rejects, should not throw (fire-and-forget)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network failure'));
    vi.stubGlobal('fetch', mockFetch);

    const hook = buildWebhookSiemErrorHook('https://siem.example.com/ingest', 'secret');
    expect(() =>
      hook({ level: 'ERROR', message: 'x', timestamp: new Date().toISOString(), hostname: 'h', pid: 1 })
    ).not.toThrow();

    // flush — the rejection should be silently caught
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

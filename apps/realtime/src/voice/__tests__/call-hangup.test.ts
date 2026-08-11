/**
 * Hangup tests.
 *
 * This is the function that makes every metering limit a real limit: closing our
 * own socket stops us listening, and only this ends the browser's call. So the
 * cases that matter are the ones about what it reports back — a teardown path
 * that mistakes "already ended" for "refused" cries wolf on every healthy call,
 * and one that throws stops the teardown it was called from.
 */

import { describe, it, expect, vi } from 'vitest';
import { hangUpCall, REALTIME_HANGUP_URL } from '../call-hangup';

const response = (status: number): Response =>
  ({ ok: status >= 200 && status < 300, status }) as Response;

describe('hangUpCall', () => {
  it("should address the call by id and authenticate with that call's own secret", async () => {
    const fetchFn = vi.fn(async () => response(200));

    const result = await hangUpCall('rtc_abc', 'ek_secret', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${REALTIME_HANGUP_URL}/rtc_abc/hangup`);
    expect(init.method).toBe('POST');
    // The API key never reaches this process; the ephemeral secret is the only
    // credential it holds, and the only one that can address a call.
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ek_secret');
  });

  it('given a call id needing escaping, should not build the URL by concatenation', async () => {
    const fetchFn = vi.fn(async () => response(200));

    await hangUpCall('rtc_a/b?c', 'ek_secret', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${REALTIME_HANGUP_URL}/rtc_a%2Fb%3Fc/hangup`);
  });

  it('given a 404, should report success — the call this asks to end is already ended', async () => {
    // The ordinary path: the user hung up in the browser, OpenAI tore the call
    // down, and our teardown asks anyway. Reporting a refusal here would put a
    // warning on the most common way a call ends.
    const fetchFn = vi.fn(async () => response(404));

    await expect(
      hangUpCall('rtc_gone', 'ek_secret', { fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBe(true);
  });

  it('given a genuine refusal, should report failure rather than claim the call ended', async () => {
    const fetchFn = vi.fn(async () => response(500));

    await expect(
      hangUpCall('rtc_abc', 'ek_secret', { fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBe(false);
  });

  it('given a transport failure, should resolve false rather than throw into a teardown path', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

    await expect(
      hangUpCall('rtc_abc', 'ek_secret', { fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBe(false);
  });

  it('given a non-Error thrown value, should still resolve false', async () => {
    const fetchFn = vi.fn(async () => {
      throw 'string blip';
    });

    await expect(
      hangUpCall('rtc_abc', 'ek_secret', { fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBe(false);
  });

  it('given no injected fetch, should fall back to the global one', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response(200));

    await expect(hangUpCall('rtc_abc', 'ek_secret')).resolves.toBe(true);
    expect(globalFetch).toHaveBeenCalled();

    globalFetch.mockRestore();
  });
});

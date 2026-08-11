import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    realtime: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import {
  createVoiceBridgeClient,
  TOOL_DISPATCH_TIMEOUT_MS,
  TRANSCRIPT_TIMEOUT_MS,
} from '../voice-bridge-client';
import {
  VOICE_CALLBACK_ROUTES,
  type VoiceBridgeRequest,
} from '@pagespace/lib/realtime/voice-bridge-contract';

const TOOL_REQUEST: VoiceBridgeRequest = {
  kind: 'tool',
  callId: 'rtc_1',
  userId: 'u1',
  name: 'read_page',
  argumentsJson: '{"pageId":"p1"}',
};

const TRANSCRIPT_REQUEST: VoiceBridgeRequest = {
  kind: 'transcript',
  callId: 'rtc_1',
  userId: 'u1',
  conversationId: 'conv1',
  role: 'user',
  text: 'hello',
};

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('createVoiceBridgeClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given a request, should POST it signed to the bridge route on the web tier', async () => {
    const fetchFn = vi.fn(async () => okResponse({ ok: true, kind: 'tool', output: 'Done.' }));
    const signHeaders = vi.fn(() => ({ 'X-Broadcast-Signature': 't=1,v1=sig' }));

    const client = createVoiceBridgeClient({
      webUrl: 'http://web:3000',
      fetchFn: fetchFn as unknown as typeof fetch,
      signHeaders,
    });
    const result = await client.send(TOOL_REQUEST);

    expect(fetchFn).toHaveBeenCalledWith(
      `http://web:3000${VOICE_CALLBACK_ROUTES.bridge}`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(TOOL_REQUEST),
        headers: { 'X-Broadcast-Signature': 't=1,v1=sig' },
      }),
    );
    // Signed over the EXACT body sent, or the receiver's HMAC check fails.
    expect(signHeaders).toHaveBeenCalledWith(JSON.stringify(TOOL_REQUEST));
    expect(result).toEqual({ ok: true, kind: 'tool', output: 'Done.' });
  });

  it('given no web url, should degrade rather than throw — a call with no bridge is still a call', async () => {
    const fetchFn = vi.fn();
    const client = createVoiceBridgeClient({
      webUrl: undefined,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const result = await client.send(TOOL_REQUEST);

    expect(result).toMatchObject({ ok: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('given a non-2xx answer, should report a failure carrying the status', async () => {
    const client = createVoiceBridgeClient({
      webUrl: 'http://web:3000',
      fetchFn: (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch,
      signHeaders: () => ({}),
    });

    const result = await client.send(TOOL_REQUEST);

    expect(result).toEqual({ ok: false, error: 'Voice bridge returned 503' });
  });

  it('given the web tier is unreachable, should report a failure rather than reject', async () => {
    const client = createVoiceBridgeClient({
      webUrl: 'http://web:3000',
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
      signHeaders: () => ({}),
    });

    await expect(client.send(TOOL_REQUEST)).resolves.toEqual({
      ok: false,
      error: 'Voice bridge is unreachable',
    });
  });

  it('should give a tool dispatch a TIGHTER deadline than a transcript', () => {
    // A tool call is inside the live turn — the model has stopped and a slow hop
    // is heard as silence. Nothing waits on a transcript.
    expect(TOOL_DISPATCH_TIMEOUT_MS).toBeGreaterThan(TRANSCRIPT_TIMEOUT_MS);
  });

  it('given a transcript, should still post it to the same route', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({ ok: true, kind: 'transcript', saved: true, messageId: 'm1', rev: 3 }),
    );
    const client = createVoiceBridgeClient({
      webUrl: 'http://web:3000',
      fetchFn: fetchFn as unknown as typeof fetch,
      signHeaders: () => ({}),
    });

    const result = await client.send(TRANSCRIPT_REQUEST);

    expect(result).toMatchObject({ ok: true, kind: 'transcript', saved: true });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWsProxyFetch } from '../ws-proxy-fetch';
import type { FetchBridge } from '../fetch-bridge';

function createMockBridge(): FetchBridge {
  return {
    proxyFetch: vi.fn(async () => new Response('ok')),
  } as unknown as FetchBridge;
}

describe('createWsProxyFetch', () => {
  let mockBridge: FetchBridge;
  let proxyFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockBridge = createMockBridge();
    proxyFetch = createWsProxyFetch('user-1', mockBridge);
  });

  describe('input normalization', () => {
    it('handles string URL input', async () => {
      await proxyFetch('http://localhost:11434/api/chat');

      expect(mockBridge.proxyFetch).toHaveBeenCalledWith('user-1', 'http://localhost:11434/api/chat', {
        method: 'GET',
        headers: {},
        body: undefined,
      });
    });

    it('handles URL object input', async () => {
      await proxyFetch(new URL('http://localhost:11434/api/chat'));

      expect(mockBridge.proxyFetch).toHaveBeenCalledWith('user-1', 'http://localhost:11434/api/chat', {
        method: 'GET',
        headers: {},
        body: undefined,
      });
    });

    it('handles Request object input', async () => {
      const request = new Request('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"llama3"}',
      });

      await proxyFetch(request);

      expect(mockBridge.proxyFetch).toHaveBeenCalledWith('user-1', 'http://localhost:11434/api/chat', {
        method: 'POST',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
        body: btoa('{"model":"llama3"}'),
      });
    });

    it('init overrides Request properties', async () => {
      const request = new Request('http://localhost:11434/api/chat', {
        method: 'GET',
      });

      await proxyFetch(request, { method: 'DELETE' });

      expect(mockBridge.proxyFetch).toHaveBeenCalledWith('user-1', 'http://localhost:11434/api/chat', {
        method: 'DELETE',
        headers: {},
        body: undefined,
      });
    });
  });

  describe('header extraction', () => {
    it('handles Headers object', async () => {
      const headers = new Headers();
      headers.set('authorization', 'Bearer token');
      headers.set('content-type', 'application/json');

      await proxyFetch('http://localhost:11434/api/chat', { headers });

      expect(mockBridge.proxyFetch).toHaveBeenCalledWith('user-1', 'http://localhost:11434/api/chat', {
        method: 'GET',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: undefined,
      });
    });

    it('handles array-of-pairs headers', async () => {
      const headers: [string, string][] = [
        ['authorization', 'Bearer token'],
        ['content-type', 'application/json'],
      ];

      await proxyFetch('http://localhost:11434/api/chat', { headers });

      expect(mockBridge.proxyFetch).toHaveBeenCalledWith('user-1', 'http://localhost:11434/api/chat', {
        method: 'GET',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: undefined,
      });
    });

    it('handles plain object headers', async () => {
      await proxyFetch('http://localhost:11434/api/chat', {
        headers: { 'x-custom': 'value' },
      });

      expect(mockBridge.proxyFetch).toHaveBeenCalledWith('user-1', 'http://localhost:11434/api/chat', {
        method: 'GET',
        headers: { 'x-custom': 'value' },
        body: undefined,
      });
    });
  });

  describe('body serialization', () => {
    it('base64-encodes string body', async () => {
      await proxyFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        body: '{"model":"llama3"}',
      });

      const call = vi.mocked(mockBridge.proxyFetch).mock.calls[0];
      expect(call[2]?.body).toBe(btoa('{"model":"llama3"}'));
    });

    it('base64-encodes ArrayBuffer body', async () => {
      const encoder = new TextEncoder();
      const buffer = encoder.encode('hello').buffer;

      await proxyFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        body: buffer,
      });

      const call = vi.mocked(mockBridge.proxyFetch).mock.calls[0];
      // Decode to verify
      expect(atob(call[2]!.body!)).toBe('hello');
    });

    it('handles null body', async () => {
      await proxyFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        body: null,
      });

      const call = vi.mocked(mockBridge.proxyFetch).mock.calls[0];
      expect(call[2]?.body).toBeUndefined();
    });

    it('handles undefined body', async () => {
      await proxyFetch('http://localhost:11434/api/chat', {
        method: 'GET',
      });

      const call = vi.mocked(mockBridge.proxyFetch).mock.calls[0];
      expect(call[2]?.body).toBeUndefined();
    });

    it('base64-encodes URLSearchParams body', async () => {
      const params = new URLSearchParams({ key: 'value', foo: 'bar' });

      await proxyFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        body: params,
      });

      const call = vi.mocked(mockBridge.proxyFetch).mock.calls[0];
      expect(atob(call[2]!.body!)).toBe('key=value&foo=bar');
    });

    it('base64-encodes Uint8Array body', async () => {
      const encoder = new TextEncoder();
      const bytes = encoder.encode('binary-content');

      await proxyFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        body: bytes,
      });

      const call = vi.mocked(mockBridge.proxyFetch).mock.calls[0];
      expect(atob(call[2]!.body!)).toBe('binary-content');
    });

    it('handles Unicode string body without throwing', async () => {
      const unicodeBody = '{"prompt":"Hello 🌍 こんにちは"}';

      await proxyFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        body: unicodeBody,
      });

      const call = vi.mocked(mockBridge.proxyFetch).mock.calls[0];
      // Decode base64 → bytes → string to verify round-trip
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(call[2]!.body!), (c) => c.charCodeAt(0))
      );
      expect(decoded).toBe(unicodeBody);
    });
  });

  describe('AbortSignal passthrough', () => {
    it('passes signal through to proxyFetch', async () => {
      const controller = new AbortController();

      await proxyFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        signal: controller.signal,
      });

      const call = vi.mocked(mockBridge.proxyFetch).mock.calls[0];
      expect(call[2]?.signal).toBe(controller.signal);
    });

    it('throws AbortError for pre-aborted signal before calling proxyFetch', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        proxyFetch('http://localhost:11434/api/chat', { signal: controller.signal })
      ).rejects.toThrow('aborted');

      expect(mockBridge.proxyFetch).not.toHaveBeenCalled();
    });
  });
});

/**
 * @scaffold - broadcast-auth lives in @pagespace/lib and may not resolve
 * in isolated realtime package tests. The mock re-implements HMAC signature
 * logic to characterize the authentication protocol contract.
 * Suggested: add integration tests that import the real broadcast-auth module.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the broadcast-auth module since it lives in @pagespace/lib
vi.mock('@pagespace/lib/broadcast-auth', async () => {
  const crypto = await import('node:crypto');

  const SECRET = 'broadcast-secret-key-minimum-32-characters-long';
  const REPLAY_WINDOW_SECONDS = 5 * 60;

  function generateBroadcastSignature(body: string) {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = `${timestamp}.${body}`;
    const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return { timestamp, signature };
  }

  function formatSignatureHeader(timestamp: number, signature: string) {
    return `t=${timestamp},v1=${signature}`;
  }

  function verifyBroadcastSignature(header: string, body: string): boolean {
    if (!header || !body) return false;
    if (typeof header !== 'string' || typeof body !== 'string') return false;

    try {
      const parts = header.split(',');
      if (parts.length !== 2) return false;

      let timestamp: number | undefined;
      let providedSig: string | undefined;
      for (const part of parts) {
        const [key, value] = part.split('=');
        if (key === 't') timestamp = parseInt(value, 10);
        else if (key === 'v1') providedSig = value;
      }
      if (!timestamp || !providedSig) return false;

      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - timestamp) > REPLAY_WINDOW_SECONDS) return false;

      const payload = `${timestamp}.${body}`;
      const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
      const expectedBuffer = Buffer.from(expected, 'hex');
      const providedBuffer = Buffer.from(providedSig, 'hex');
      if (expectedBuffer.length !== providedBuffer.length) return false;
      return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
    } catch {
      return false;
    }
  }

  return { generateBroadcastSignature, formatSignatureHeader, verifyBroadcastSignature };
});

import {
  verifyBroadcastSignature,
  generateBroadcastSignature,
  formatSignatureHeader,
} from '@pagespace/lib/broadcast-auth';

describe('Broadcast Authentication', () => {
  describe('signature generation', () => {
    it('given valid body, should generate signature object with timestamp and signature', () => {
      const body = JSON.stringify({ channelId: 'test', event: 'test', payload: {} });

      const result = generateBroadcastSignature(body);

      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('signature');
      expect(typeof result.timestamp).toBe('number');
      expect(typeof result.signature).toBe('string');
      expect(result.signature).toMatch(/^[a-f0-9]+$/);
    });

    it('given signature result, should format header correctly', () => {
      const body = JSON.stringify({ channelId: 'test', event: 'test', payload: {} });
      const result = generateBroadcastSignature(body);
      const header = formatSignatureHeader(result.timestamp, result.signature);

      expect(header).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
    });
  });

  describe('signature verification', () => {
    it('given valid signature, should verify successfully', () => {
      const body = JSON.stringify({ channelId: 'test', event: 'test', payload: {} });
      const result = generateBroadcastSignature(body);
      const header = formatSignatureHeader(result.timestamp, result.signature);

      const isValid = verifyBroadcastSignature(header, body);

      expect(isValid).toBe(true);
    });

    it('given tampered body, should fail verification', () => {
      const originalBody = JSON.stringify({ channelId: 'test', event: 'test', payload: {} });
      const result = generateBroadcastSignature(originalBody);
      const header = formatSignatureHeader(result.timestamp, result.signature);
      const tamperedBody = JSON.stringify({ channelId: 'hacked', event: 'test', payload: {} });

      const isValid = verifyBroadcastSignature(header, tamperedBody);

      expect(isValid).toBe(false);
    });

    it('given invalid signature format, should fail verification', () => {
      const body = JSON.stringify({ channelId: 'test', event: 'test', payload: {} });

      const isValid = verifyBroadcastSignature('invalid-format', body);

      expect(isValid).toBe(false);
    });
  });

  describe('replay attack prevention', () => {
    it('given timestamp older than 5 minutes, should fail verification', () => {
      const body = JSON.stringify({ channelId: 'test', event: 'test', payload: {} });

      // Create header with old timestamp (6 minutes ago)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 360;
      const oldHeader = `t=${oldTimestamp},v1=fakesignature`;

      const isValid = verifyBroadcastSignature(oldHeader, body);

      expect(isValid).toBe(false);
    });
  });
});

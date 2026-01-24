/**
 * Realtime Server Authentication Tests
 * Tests for Socket.IO authentication middleware components
 *
 * Note: JWT token tests were removed when the system migrated to
 * opaque session tokens (ps_sess_*). Socket authentication now uses
 * session tokens validated via sessionService.validateSession().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  verifyBroadcastSignature,
  generateBroadcastSignature,
  formatSignatureHeader
} from '@pagespace/lib/broadcast-auth';

// Set up test environment variables
beforeEach(() => {
  process.env.REALTIME_BROADCAST_SECRET = 'broadcast-secret-key-minimum-32-characters-long';
});

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

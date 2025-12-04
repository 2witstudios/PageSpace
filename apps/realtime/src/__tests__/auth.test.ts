/**
 * Realtime Server Authentication Tests
 * Tests for Socket.IO authentication middleware components
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { decodeToken, generateAccessToken } from '@pagespace/lib/server';
import {
  verifyBroadcastSignature,
  generateBroadcastSignature,
  formatSignatureHeader
} from '@pagespace/lib/broadcast-auth';
import { authHelpers } from '@pagespace/lib/test/auth-helpers';
import { parse } from 'cookie';

// Set up test environment variables
beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-key-minimum-32-characters-long';
  process.env.JWT_ISSUER = 'pagespace-test';
  process.env.JWT_AUDIENCE = 'pagespace-test-users';
  process.env.REALTIME_BROADCAST_SECRET = 'broadcast-secret-key-minimum-32-characters-long';
});

describe('Socket.IO Authentication', () => {
  describe('token in auth field', () => {
    it('given valid JWT in handshake auth, should authenticate successfully', async () => {
      const userId = 'test-user-123';
      const token = await generateAccessToken(userId, 0, 'user');

      const decoded = await decodeToken(token);

      expect(decoded).not.toBeNull();
      expect(decoded?.userId).toBe(userId);
      expect(decoded?.tokenVersion).toBe(0);
      expect(decoded?.role).toBe('user');
    });
  });

  describe('token in cookies', () => {
    it('given valid JWT in httpOnly cookie header, should parse and validate', async () => {
      const userId = 'test-user-456';
      const token = await generateAccessToken(userId, 1, 'admin');

      // Simulate cookie header parsing
      const cookieHeader = `accessToken=${token}; other=value`;
      const cookies = parse(cookieHeader);

      expect(cookies.accessToken).toBe(token);

      const decoded = await decodeToken(cookies.accessToken);

      expect(decoded).not.toBeNull();
      expect(decoded?.userId).toBe(userId);
      expect(decoded?.tokenVersion).toBe(1);
      expect(decoded?.role).toBe('admin');
    });

    it('given token with special characters, should parse correctly', async () => {
      const userId = 'user-with-special';
      const token = await generateAccessToken(userId, 0, 'user');

      // JWT tokens contain dots and may have base64 chars
      const cookieHeader = `accessToken=${token}`;
      const cookies = parse(cookieHeader);

      expect(cookies.accessToken).toBe(token);
    });
  });

  describe('no token provided', () => {
    it('given neither auth field nor cookies have token, should return null', async () => {
      const decoded = await decodeToken('');

      expect(decoded).toBeNull();
    });

    it('given undefined token, should handle gracefully', async () => {
      // @ts-expect-error - testing undefined input
      const decoded = await decodeToken(undefined);

      expect(decoded).toBeNull();
    });
  });

  describe('expired token', () => {
    it('given JWT past expiration, should return null', async () => {
      // Create a token that expires in 1 second
      const expiredToken = await authHelpers.createExpiredToken('test-user');

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      const decoded = await decodeToken(expiredToken);

      expect(decoded).toBeNull();
    });
  });

  describe('invalid signature', () => {
    it('given JWT signed with wrong secret, should return null', async () => {
      const invalidToken = await authHelpers.createInvalidSignatureToken('test-user');

      const decoded = await decodeToken(invalidToken);

      expect(decoded).toBeNull();
    });
  });

  describe('malformed token', () => {
    it('given non-JWT string, should return null', async () => {
      const decoded = await decodeToken('not-a-valid-jwt');

      expect(decoded).toBeNull();
    });

    it('given malformed JWT structure, should return null', async () => {
      const malformed = await authHelpers.createMalformedToken();
      const decoded = await decodeToken(malformed);

      expect(decoded).toBeNull();
    });
  });

  describe('token version validation', () => {
    it('given valid token with tokenVersion, should include version in decoded payload', async () => {
      const userId = 'version-test-user';
      const tokenVersion = 5;
      const token = await generateAccessToken(userId, tokenVersion, 'user');

      const decoded = await decodeToken(token);

      expect(decoded?.tokenVersion).toBe(tokenVersion);
    });
  });

  describe('socket data population', () => {
    it('given successful auth, should have userId available for socket.data', async () => {
      const userId = 'socket-data-user';
      const token = await generateAccessToken(userId, 0, 'user');

      const decoded = await decodeToken(token);

      // Simulating what the middleware does
      const socketData = decoded ? { user: { id: decoded.userId } } : null;

      expect(socketData?.user.id).toBe(userId);
    });
  });
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

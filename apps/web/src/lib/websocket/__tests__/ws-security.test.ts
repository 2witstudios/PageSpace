import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  getConnectionFingerprint,
  verifyFingerprint,
  validateMessageSize,
  logSecurityEvent,
  isSecureConnection,
} from '../ws-security';

// Mock @pagespace/lib logger to avoid side effects
vi.mock('@pagespace/lib', () => ({
  logger: {
    child: vi.fn(() => ({
      fatal: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

import { logger } from '@pagespace/lib';

function makeNextRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as unknown as NextRequest;
}

describe('ws-security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getConnectionFingerprint', () => {
    it('should return a 64-character hex SHA256 hash', () => {
      const request = makeNextRequest({
        'x-forwarded-for': '1.2.3.4',
        'user-agent': 'TestAgent/1.0',
      });

      const fingerprint = getConnectionFingerprint(request);

      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce consistent fingerprints for the same IP and user-agent', () => {
      const headers = { 'x-forwarded-for': '10.0.0.1', 'user-agent': 'SameAgent/2.0' };
      const fp1 = getConnectionFingerprint(makeNextRequest(headers));
      const fp2 = getConnectionFingerprint(makeNextRequest(headers));

      expect(fp1).toBe(fp2);
    });

    it('should produce different fingerprints for different IPs', () => {
      const fp1 = getConnectionFingerprint(
        makeNextRequest({ 'x-forwarded-for': '1.1.1.1', 'user-agent': 'Agent/1.0' })
      );
      const fp2 = getConnectionFingerprint(
        makeNextRequest({ 'x-forwarded-for': '2.2.2.2', 'user-agent': 'Agent/1.0' })
      );

      expect(fp1).not.toBe(fp2);
    });

    it('should produce different fingerprints for different user-agents', () => {
      const fp1 = getConnectionFingerprint(
        makeNextRequest({ 'x-forwarded-for': '1.1.1.1', 'user-agent': 'Chrome/100' })
      );
      const fp2 = getConnectionFingerprint(
        makeNextRequest({ 'x-forwarded-for': '1.1.1.1', 'user-agent': 'Firefox/90' })
      );

      expect(fp1).not.toBe(fp2);
    });

    it('should use the first IP from x-forwarded-for when multiple are present', () => {
      const fpMultiple = getConnectionFingerprint(
        makeNextRequest({ 'x-forwarded-for': '5.5.5.5, 10.0.0.1, 192.168.1.1', 'user-agent': 'A' })
      );
      const fpSingle = getConnectionFingerprint(
        makeNextRequest({ 'x-forwarded-for': '5.5.5.5', 'user-agent': 'A' })
      );

      expect(fpMultiple).toBe(fpSingle);
    });

    it('should fall back to x-real-ip when x-forwarded-for is absent', () => {
      const fpReal = getConnectionFingerprint(
        makeNextRequest({ 'x-real-ip': '8.8.8.8', 'user-agent': 'Agent' })
      );
      const fpForwarded = getConnectionFingerprint(
        makeNextRequest({ 'x-forwarded-for': '8.8.8.8', 'user-agent': 'Agent' })
      );

      expect(fpReal).toBe(fpForwarded);
    });

    it('should use "unknown" for IP when no IP headers are present', () => {
      const fpUnknown = getConnectionFingerprint(
        makeNextRequest({ 'user-agent': 'MyAgent' })
      );
      // Should still be a valid hash
      expect(fpUnknown).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should use "unknown" for user-agent when header is absent', () => {
      const fp = getConnectionFingerprint(
        makeNextRequest({ 'x-forwarded-for': '1.2.3.4' })
      );
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('verifyFingerprint', () => {
    it('should return true when fingerprints match', () => {
      expect(verifyFingerprint('abc123', 'abc123')).toBe(true);
    });

    it('should return false when fingerprints differ', () => {
      expect(verifyFingerprint('abc123', 'xyz789')).toBe(false);
    });

    it('should return false for empty string vs non-empty', () => {
      expect(verifyFingerprint('', 'abc')).toBe(false);
    });

    it('should return true for two empty strings', () => {
      expect(verifyFingerprint('', '')).toBe(true);
    });

    it('should be case-sensitive', () => {
      expect(verifyFingerprint('ABC', 'abc')).toBe(false);
    });

    it('should return false when current fingerprint is from a different IP (mid-session IP change)', () => {
      const stored = 'fingerprint-for-original-ip';
      const current = 'fingerprint-for-new-ip';
      expect(verifyFingerprint(current, stored)).toBe(false);
    });
  });

  describe('validateMessageSize', () => {
    const ONE_MB = 1024 * 1024;

    it('should return valid true for a small string message', () => {
      const result = validateMessageSize('hello world');
      expect(result.valid).toBe(true);
    });

    it('should return valid true for a string message exactly at the limit', () => {
      const message = 'a'.repeat(ONE_MB);
      const result = validateMessageSize(message);
      expect(result.valid).toBe(true);
    });

    it('should return valid false for a string message exceeding 1MB', () => {
      const message = 'a'.repeat(ONE_MB + 1);
      const result = validateMessageSize(message);
      expect(result.valid).toBe(false);
      expect(result.size).toBeGreaterThan(ONE_MB);
      expect(result.maxSize).toBe(ONE_MB);
    });

    it('should return valid true for a Buffer within the size limit', () => {
      const buf = Buffer.alloc(100);
      const result = validateMessageSize(buf);
      expect(result.valid).toBe(true);
    });

    it('should return valid false for a Buffer exceeding 1MB', () => {
      const buf = Buffer.alloc(ONE_MB + 1);
      const result = validateMessageSize(buf);
      expect(result.valid).toBe(false);
      expect(result.size).toBe(ONE_MB + 1);
    });

    it('should return valid true for an ArrayBuffer within size limit', () => {
      const buf = new ArrayBuffer(512);
      const result = validateMessageSize(buf);
      expect(result.valid).toBe(true);
    });

    it('should return valid false for an ArrayBuffer exceeding 1MB', () => {
      const buf = new ArrayBuffer(ONE_MB + 100);
      const result = validateMessageSize(buf);
      expect(result.valid).toBe(false);
    });

    it('should return valid true for a Buffer array with total size within limit', () => {
      const bufs = [Buffer.alloc(100), Buffer.alloc(200)];
      const result = validateMessageSize(bufs);
      expect(result.valid).toBe(true);
    });

    it('should return valid false for a Buffer array with total size exceeding 1MB', () => {
      const bufs = [Buffer.alloc(ONE_MB / 2 + 1), Buffer.alloc(ONE_MB / 2 + 1)];
      const result = validateMessageSize(bufs);
      expect(result.valid).toBe(false);
    });

    it('should return size and maxSize fields when invalid', () => {
      const result = validateMessageSize('a'.repeat(ONE_MB + 50));
      expect(result.size).toBeDefined();
      expect(result.maxSize).toBe(ONE_MB);
    });

    it('should not return size or maxSize fields when valid', () => {
      const result = validateMessageSize('small');
      expect(result.size).toBeUndefined();
      expect(result.maxSize).toBeUndefined();
    });

    it('should return valid true for an empty string', () => {
      const result = validateMessageSize('');
      expect(result.valid).toBe(true);
    });

    it('should return valid true for an empty Buffer', () => {
      const result = validateMessageSize(Buffer.alloc(0));
      expect(result.valid).toBe(true);
    });

    it('should return valid true for an empty Buffer array', () => {
      const result = validateMessageSize([]);
      expect(result.valid).toBe(true);
    });
  });

  describe('logSecurityEvent', () => {
    let mockChildLogger: {
      fatal: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      debug: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockChildLogger = {
        fatal: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };
      vi.mocked(logger.child).mockReturnValue(mockChildLogger as unknown as ReturnType<typeof logger.child>);
    });

    it('should create a child logger with context including component and eventType', () => {
      logSecurityEvent('test-event', { severity: 'info' });

      expect(logger.child).toHaveBeenCalledWith(
        expect.objectContaining({
          component: 'ws-security',
          eventType: 'test-event',
        })
      );
    });

    it('should route critical severity to fatal log level', () => {
      logSecurityEvent('critical-event', { severity: 'critical' });
      expect(mockChildLogger.fatal).toHaveBeenCalledOnce();
      expect(mockChildLogger.error).not.toHaveBeenCalled();
    });

    it('should route error severity to error log level', () => {
      logSecurityEvent('error-event', { severity: 'error' });
      expect(mockChildLogger.error).toHaveBeenCalledOnce();
      expect(mockChildLogger.fatal).not.toHaveBeenCalled();
    });

    it('should route warn severity to warn log level', () => {
      logSecurityEvent('warn-event', { severity: 'warn' });
      expect(mockChildLogger.warn).toHaveBeenCalledOnce();
    });

    it('should route info severity to info log level', () => {
      logSecurityEvent('info-event', { severity: 'info' });
      expect(mockChildLogger.info).toHaveBeenCalledOnce();
    });

    it('should include the event name in the log message', () => {
      logSecurityEvent('RATE_LIMIT_EXCEEDED', { severity: 'warn' });
      expect(mockChildLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('RATE_LIMIT_EXCEEDED'),
        expect.anything()
      );
    });

    it('should include userId in the child logger context', () => {
      logSecurityEvent('auth-event', { severity: 'info', userId: 'user-123' });

      expect(logger.child).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('should include ip in the child logger context', () => {
      logSecurityEvent('connection-event', { severity: 'info', ip: '192.168.1.100' });

      expect(logger.child).toHaveBeenCalledWith(
        expect.objectContaining({ ip: '192.168.1.100' })
      );
    });

    it('should pass extra metadata to the log call', () => {
      logSecurityEvent('event', { severity: 'info', extraField: 'extra-value' });

      expect(mockChildLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ extraField: 'extra-value' })
      );
    });

    it('should not include userId and ip in the metadata object passed to log call', () => {
      logSecurityEvent('event', { severity: 'info', userId: 'u1', ip: '1.1.1.1', otherKey: 'val' });

      const metadataArg = mockChildLogger.info.mock.calls[0][1];
      expect(metadataArg).not.toHaveProperty('userId');
      expect(metadataArg).not.toHaveProperty('ip');
      expect(metadataArg).toHaveProperty('otherKey', 'val');
    });
  });

  describe('isSecureConnection', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('should return true for localhost URLs', () => {
      expect(isSecureConnection('http://localhost:3000/api/ws')).toBe(true);
    });

    it('should return true for 127.0.0.1 URLs', () => {
      expect(isSecureConnection('http://127.0.0.1:3000/api/ws')).toBe(true);
    });

    it('should return true in non-production environment regardless of protocol', () => {
      process.env.NODE_ENV = 'development';
      expect(isSecureConnection('ws://example.com/ws')).toBe(true);
    });

    it('should return true in test environment regardless of protocol', () => {
      process.env.NODE_ENV = 'test';
      expect(isSecureConnection('ws://example.com/ws')).toBe(true);
    });

    it('should return true in production for wss:// URLs without request', () => {
      process.env.NODE_ENV = 'production';
      expect(isSecureConnection('wss://example.com/ws')).toBe(true);
    });

    it('should return true in production for https:// URLs without request', () => {
      process.env.NODE_ENV = 'production';
      expect(isSecureConnection('https://example.com/api')).toBe(true);
    });

    it('should return false in production for ws:// URLs without request or proxy header', () => {
      process.env.NODE_ENV = 'production';
      expect(isSecureConnection('ws://example.com/ws')).toBe(false);
    });

    it('should return false in production for http:// URLs without proxy header', () => {
      process.env.NODE_ENV = 'production';
      expect(isSecureConnection('http://example.com/api')).toBe(false);
    });

    it('should return true in production when x-forwarded-proto is https', () => {
      process.env.NODE_ENV = 'production';
      const request = { headers: { get: (name: string) => name === 'x-forwarded-proto' ? 'https' : null } };
      expect(isSecureConnection('http://example.com/ws', request)).toBe(true);
    });

    it('should return true in production when x-forwarded-proto is wss', () => {
      process.env.NODE_ENV = 'production';
      const request = { headers: { get: (name: string) => name === 'x-forwarded-proto' ? 'wss' : null } };
      expect(isSecureConnection('ws://example.com/ws', request)).toBe(true);
    });

    it('should return false in production when x-forwarded-proto is http', () => {
      process.env.NODE_ENV = 'production';
      const request = { headers: { get: (name: string) => name === 'x-forwarded-proto' ? 'http' : null } };
      expect(isSecureConnection('http://example.com/ws', request)).toBe(false);
    });

    it('should return false in production when x-forwarded-proto header is absent and URL is insecure', () => {
      process.env.NODE_ENV = 'production';
      const request = { headers: { get: () => null } };
      expect(isSecureConnection('ws://example.com/ws', request)).toBe(false);
    });

    it('should return true for localhost even in production', () => {
      process.env.NODE_ENV = 'production';
      expect(isSecureConnection('http://localhost:3000')).toBe(true);
    });
  });
});

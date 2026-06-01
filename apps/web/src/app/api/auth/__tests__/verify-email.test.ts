import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../verify-email/route';
import { NextRequest } from 'next/server';

// Mock dependencies
vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  verifyToken: vi.fn(),
  markEmailVerified: vi.fn().mockResolvedValue(undefined),
  markEmailVerifiedForAddress: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    security: {
      warn: vi.fn(),
    },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

import { verifyToken, markEmailVerified, markEmailVerifiedForAddress } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';

describe('/api/auth/verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: valid legacy token (no bound email in metadata)
    vi.mocked(verifyToken).mockResolvedValue({ userId: 'test-user-id', metadata: null });
    vi.mocked(markEmailVerifiedForAddress).mockResolvedValue(true);
  });

  describe('successful verification', () => {
    it('returns 303 redirect to dashboard on successful verification', async () => {
      // Arrange
      const url = new URL('http://localhost/api/auth/verify-email?token=valid-token');
      const request = new NextRequest(url);

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toContain('/dashboard?auth=success');
    });

    it('verifies token with correct type', async () => {
      // Arrange
      const url = new URL('http://localhost/api/auth/verify-email?token=valid-token');
      const request = new NextRequest(url);

      // Act
      await GET(request);

      // Assert
      expect(verifyToken).toHaveBeenCalledWith('valid-token', 'email_verification');
    });

    it('marks email as verified', async () => {
      // Arrange
      const url = new URL('http://localhost/api/auth/verify-email?token=valid-token');
      const request = new NextRequest(url);

      // Act
      await GET(request);

      // Assert
      expect(markEmailVerified).toHaveBeenCalledWith('test-user-id');
    });

    it('logs successful verification', async () => {
      // Arrange
      const url = new URL('http://localhost/api/auth/verify-email?token=valid-token');
      const request = new NextRequest(url);

      // Act
      await GET(request);

      // Assert
      expect(loggers.auth.info).toHaveBeenCalledWith('Email verified', {
        userId: 'test-user-id',
      });
    });

    it('tracks email_verified event', async () => {
      // Arrange
      const url = new URL('http://localhost/api/auth/verify-email?token=valid-token');
      const request = new NextRequest(url);

      // Act
      await GET(request);

      // Assert
      expect(trackAuthEvent).toHaveBeenCalledWith('test-user-id', 'email_verified', {});
    });
  });

  describe('address-bound verification', () => {
    it('verifies the bound address atomically and does not use the unbound path', async () => {
      // Arrange — token carries a bound email in metadata
      vi.mocked(verifyToken).mockResolvedValue({
        userId: 'test-user-id',
        metadata: JSON.stringify({ email: 'bound@example.com' }),
      });
      vi.mocked(markEmailVerifiedForAddress).mockResolvedValue(true);

      const url = new URL('http://localhost/api/auth/verify-email?token=valid-token');
      const request = new NextRequest(url);

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(303);
      expect(markEmailVerifiedForAddress).toHaveBeenCalledWith('test-user-id', 'bound@example.com');
      expect(markEmailVerified).not.toHaveBeenCalled();
    });

    it('rejects when the stored email changed since the token was issued', async () => {
      // Arrange — bound email no longer matches the user's current address
      vi.mocked(verifyToken).mockResolvedValue({
        userId: 'test-user-id',
        metadata: JSON.stringify({ email: 'bound@example.com' }),
      });
      vi.mocked(markEmailVerifiedForAddress).mockResolvedValue(false);

      const url = new URL('http://localhost/api/auth/verify-email?token=stale-token');
      const request = new NextRequest(url);

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid or expired verification token');
      expect(markEmailVerified).not.toHaveBeenCalled();
      expect(trackAuthEvent).not.toHaveBeenCalled();
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Email verification token did not match current address',
        { userId: 'test-user-id' },
      );
    });

    it('rejects tokens with present-but-unparseable metadata (does not silently fall back)', async () => {
      // Arrange — metadata is present but not valid JSON (corrupt). It must NOT
      // downgrade to the unbound markEmailVerified path.
      vi.mocked(verifyToken).mockResolvedValue({
        userId: 'test-user-id',
        metadata: 'not-json',
      });

      const url = new URL('http://localhost/api/auth/verify-email?token=valid-token');
      const request = new NextRequest(url);

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid or expired verification token');
      expect(markEmailVerified).not.toHaveBeenCalled();
      expect(markEmailVerifiedForAddress).not.toHaveBeenCalled();
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Email verification token has unparseable metadata',
        { userId: 'test-user-id' },
      );
    });
  });

  describe('missing token', () => {
    it('returns 400 when token query param is missing', async () => {
      // Arrange
      const url = new URL('http://localhost/api/auth/verify-email');
      const request = new NextRequest(url);

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.error).toBe('Verification token is required');
    });

    it('returns 400 when token is empty string', async () => {
      // Arrange
      const url = new URL('http://localhost/api/auth/verify-email?token=');
      const request = new NextRequest(url);

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.error).toBe('Verification token is required');
    });
  });

  describe('invalid or expired token', () => {
    it('returns 400 for invalid token', async () => {
      // Arrange
      vi.mocked(verifyToken).mockResolvedValue(null);

      const url = new URL('http://localhost/api/auth/verify-email?token=invalid-token');
      const request = new NextRequest(url);

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid or expired verification token');
    });

    it('returns 400 for expired token', async () => {
      // Arrange
      vi.mocked(verifyToken).mockResolvedValue(null);

      const url = new URL('http://localhost/api/auth/verify-email?token=expired-token');
      const request = new NextRequest(url);

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid or expired verification token');
    });

    it('does not mark email as verified for invalid token', async () => {
      // Arrange
      vi.mocked(verifyToken).mockResolvedValue(null);

      const url = new URL('http://localhost/api/auth/verify-email?token=invalid-token');
      const request = new NextRequest(url);

      // Act
      await GET(request);

      // Assert
      expect(markEmailVerified).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      // Arrange
      vi.mocked(verifyToken).mockRejectedValueOnce(new Error('Database error'));

      const url = new URL('http://localhost/api/auth/verify-email?token=valid-token');
      const request = new NextRequest(url);

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(body.error).toBe('Email verification failed');
    });

    it('logs errors', async () => {
      // Arrange
      const error = new Error('Database error');
      vi.mocked(verifyToken).mockRejectedValueOnce(error);

      const url = new URL('http://localhost/api/auth/verify-email?token=valid-token');
      const request = new NextRequest(url);

      // Act
      await GET(request);

      // Assert
      expect(loggers.auth.error).toHaveBeenCalledWith('Email verification error', error);
    });
  });
});

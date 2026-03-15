/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/settings/personalization
//
// Tests GET and PATCH handlers for user personalization settings (bio,
// writingStyle, rules, enabled).
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn(),
    query: {
      userPersonalization: { findFirst: vi.fn() },
    },
  },
  userPersonalization: {
    userId: 'userId',
  },
  eq: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// ============================================================================
// GET /api/settings/personalization
// ============================================================================

describe('GET /api/settings/personalization', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/settings/personalization');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('success', () => {
    it('should return default values when no personalization exists', async () => {
      vi.mocked(db.query.userPersonalization.findFirst).mockResolvedValue(null);

      const request = new Request('https://example.com/api/settings/personalization');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.personalization).toEqual({
        bio: '',
        writingStyle: '',
        rules: '',
        enabled: true,
      });
    });

    it('should return stored personalization values', async () => {
      vi.mocked(db.query.userPersonalization.findFirst).mockResolvedValue({
        id: 'pers_1',
        userId: 'user_123',
        bio: 'I am a developer',
        writingStyle: 'concise and technical',
        rules: 'Always use TypeScript',
        enabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const request = new Request('https://example.com/api/settings/personalization');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.personalization).toEqual({
        bio: 'I am a developer',
        writingStyle: 'concise and technical',
        rules: 'Always use TypeScript',
        enabled: false,
      });
    });

    it('should convert null fields to empty strings', async () => {
      vi.mocked(db.query.userPersonalization.findFirst).mockResolvedValue({
        id: 'pers_1',
        userId: 'user_123',
        bio: null,
        writingStyle: null,
        rules: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const request = new Request('https://example.com/api/settings/personalization');
      const response = await GET(request);
      const body = await response.json();

      expect(body.personalization.bio).toBe('');
      expect(body.personalization.writingStyle).toBe('');
      expect(body.personalization.rules).toBe('');
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.query.userPersonalization.findFirst).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/settings/personalization');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch personalization settings');
    });

    it('should log error when query fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.query.userPersonalization.findFirst).mockRejectedValue(error);

      const request = new Request('https://example.com/api/settings/personalization');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching personalization settings:',
        error
      );
    });
  });
});

// ============================================================================
// PATCH /api/settings/personalization
// ============================================================================

describe('PATCH /api/settings/personalization', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ bio: 'test' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ bio: 'test', writingStyle: '', rules: '', enabled: true }]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ bio: 'test' }),
      });
      await PATCH(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 when body is not an object', async () => {
      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify('invalid'),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('should return 400 when body is an array', async () => {
      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify([1, 2, 3]),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('should return 400 when no fields are provided', async () => {
      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('At least one field (bio, writingStyle, rules, enabled) is required');
    });

    it('should return 400 when bio is not a string', async () => {
      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ bio: 123 }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('bio must be a string');
    });

    it('should return 400 when writingStyle is not a string', async () => {
      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ writingStyle: 123 }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('writingStyle must be a string');
    });

    it('should return 400 when rules is not a string', async () => {
      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ rules: true }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('rules must be a string');
    });

    it('should return 400 when enabled is not a boolean', async () => {
      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: 'yes' }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('enabled must be a boolean');
    });

    it('should return 400 when bio exceeds max length', async () => {
      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ bio: 'x'.repeat(40001) }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('bio must be 40000 characters or less');
    });

    it('should return 400 when writingStyle exceeds max length', async () => {
      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ writingStyle: 'x'.repeat(40001) }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('writingStyle must be 40000 characters or less');
    });

    it('should return 400 when rules exceeds max length', async () => {
      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ rules: 'x'.repeat(40001) }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('rules must be 40000 characters or less');
    });
  });

  describe('success', () => {
    it('should upsert personalization with provided fields', async () => {
      const record = { bio: 'New bio', writingStyle: '', rules: '', enabled: true };
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([record]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ bio: 'New bio' }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.personalization).toEqual({
        bio: 'New bio',
        writingStyle: '',
        rules: '',
        enabled: true,
      });
    });

    it('should allow updating only the enabled field', async () => {
      const record = { bio: '', writingStyle: '', rules: '', enabled: false };
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([record]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.personalization.enabled).toBe(false);
    });

    it('should allow updating multiple fields at once', async () => {
      const record = {
        bio: 'Developer',
        writingStyle: 'Technical',
        rules: 'Use TS',
        enabled: true,
      };
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([record]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({
          bio: 'Developer',
          writingStyle: 'Technical',
          rules: 'Use TS',
        }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.personalization.bio).toBe('Developer');
      expect(body.personalization.writingStyle).toBe('Technical');
      expect(body.personalization.rules).toBe('Use TS');
    });
  });

  describe('error handling', () => {
    it('should return 500 when database operation fails', async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ bio: 'test' }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update personalization settings');
    });

    it('should log error when operation fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(error),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/personalization', {
        method: 'PATCH',
        body: JSON.stringify({ bio: 'test' }),
      });
      await PATCH(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error updating personalization settings:',
        error
      );
    });
  });
});

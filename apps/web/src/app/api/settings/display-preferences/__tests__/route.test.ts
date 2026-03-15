/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/settings/display-preferences
//
// Tests GET and PATCH handlers for user display preference management.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    query: {
      displayPreferences: { findFirst: vi.fn() },
    },
  },
  displayPreferences: {
    userId: 'userId',
    preferenceType: 'preferenceType',
    enabled: 'enabled',
  },
  eq: vi.fn(),
  and: vi.fn(),
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
// GET /api/settings/display-preferences
// ============================================================================

describe('GET /api/settings/display-preferences', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/settings/display-preferences');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with session-only read options', async () => {
      const request = new Request('https://example.com/api/settings/display-preferences');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('success', () => {
    it('should return default false values when no preferences exist', async () => {
      const request = new Request('https://example.com/api/settings/display-preferences');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        showTokenCounts: false,
        showCodeToggle: false,
        defaultMarkdownMode: false,
      });
    });

    it('should return stored preference values', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { preferenceType: 'SHOW_TOKEN_COUNTS', enabled: true },
            { preferenceType: 'SHOW_CODE_TOGGLE', enabled: false },
            { preferenceType: 'DEFAULT_MARKDOWN_MODE', enabled: true },
          ]),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/display-preferences');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        showTokenCounts: true,
        showCodeToggle: false,
        defaultMarkdownMode: true,
      });
    });

    it('should default missing preferences to false', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { preferenceType: 'SHOW_TOKEN_COUNTS', enabled: true },
          ]),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/display-preferences');
      const response = await GET(request);
      const body = await response.json();

      expect(body.showTokenCounts).toBe(true);
      expect(body.showCodeToggle).toBe(false);
      expect(body.defaultMarkdownMode).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/display-preferences');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch display preferences');
    });

    it('should log error when query fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(error),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/display-preferences');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching display preferences:',
        error
      );
    });
  });
});

// ============================================================================
// PATCH /api/settings/display-preferences
// ============================================================================

describe('PATCH /api/settings/display-preferences', () => {
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

      const request = new Request('https://example.com/api/settings/display-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferenceType: 'SHOW_TOKEN_COUNTS', enabled: true }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with CSRF-required write options', async () => {
      vi.mocked(db.query.displayPreferences.findFirst).mockResolvedValue(null);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: '1', enabled: true }]),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/display-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferenceType: 'SHOW_TOKEN_COUNTS', enabled: true }),
      });
      await PATCH(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 when preferenceType is missing', async () => {
      const request = new Request('https://example.com/api/settings/display-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('preferenceType and enabled are required');
    });

    it('should return 400 when enabled is missing', async () => {
      const request = new Request('https://example.com/api/settings/display-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferenceType: 'SHOW_TOKEN_COUNTS' }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('preferenceType and enabled are required');
    });

    it('should return 400 when enabled is not a boolean', async () => {
      const request = new Request('https://example.com/api/settings/display-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferenceType: 'SHOW_TOKEN_COUNTS', enabled: 'yes' }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('preferenceType and enabled are required');
    });

    it('should return 400 for invalid preference type', async () => {
      const request = new Request('https://example.com/api/settings/display-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferenceType: 'INVALID_TYPE', enabled: true }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid preference type');
    });
  });

  describe('success - update existing', () => {
    it('should update an existing preference', async () => {
      const updatedPref = { id: 'pref_1', preferenceType: 'SHOW_TOKEN_COUNTS', enabled: true };
      vi.mocked(db.query.displayPreferences.findFirst).mockResolvedValue({
        id: 'pref_1',
        preferenceType: 'SHOW_TOKEN_COUNTS',
        enabled: false,
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedPref]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/display-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferenceType: 'SHOW_TOKEN_COUNTS', enabled: true }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.preference).toEqual(updatedPref);
    });
  });

  describe('success - create new', () => {
    it('should create a new preference when none exists', async () => {
      const createdPref = { id: 'pref_new', preferenceType: 'SHOW_CODE_TOGGLE', enabled: true };
      vi.mocked(db.query.displayPreferences.findFirst).mockResolvedValue(null);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createdPref]),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/display-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferenceType: 'SHOW_CODE_TOGGLE', enabled: true }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.preference).toEqual(createdPref);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database operation fails', async () => {
      vi.mocked(db.query.displayPreferences.findFirst).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/settings/display-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferenceType: 'SHOW_TOKEN_COUNTS', enabled: true }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update display preference');
    });

    it('should log error when operation fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.query.displayPreferences.findFirst).mockRejectedValue(error);

      const request = new Request('https://example.com/api/settings/display-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferenceType: 'SHOW_TOKEN_COUNTS', enabled: true }),
      });
      await PATCH(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error updating display preference:',
        error
      );
    });
  });
});

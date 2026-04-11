/**
 * Security audit tests for /api/user/favorites
 * Verifies auditRequest is called for GET and POST.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      favorites: { findMany: vi.fn(), findFirst: vi.fn() },
      pages: { findFirst: vi.fn() },
      drives: { findFirst: vi.fn() },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'fav-1', userId: 'user_123', itemType: 'page', position: 0, createdAt: new Date() }]),
      }),
    }),
  },
  favorites: { userId: 'userId', id: 'id', pageId: 'pageId', driveId: 'driveId', position: 'position', createdAt: 'createdAt' },
  pages: { id: 'id' },
  drives: { id: 'id' },
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

import { GET, POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/server';
import { db } from '@pagespace/db';

const mockUserId = 'user_123';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

describe('GET /api/user/favorites audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(db.query.favorites.findMany).mockResolvedValue([]);
  });

  it('logs read audit event on successful favorites retrieval', async () => {
    const request = new Request('http://localhost/api/user/favorites');
    await GET(request);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.read', userId: mockUserId, resourceType: 'favorites', resourceId: 'self' }
    );
  });
});

describe('POST /api/user/favorites audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(db.query.favorites.findFirst).mockResolvedValue(undefined);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: 'page-1' } as never);
  });

  it('logs write audit event on successful favorite creation', async () => {
    const request = new Request('http://localhost/api/user/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemType: 'page', itemId: 'page-1' }),
    });

    await POST(request);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.write', userId: mockUserId, resourceType: 'favorites', resourceId: 'self' }
    );
  });
});

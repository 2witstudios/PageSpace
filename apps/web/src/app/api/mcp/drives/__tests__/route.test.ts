import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'drv-1', name: 'New', slug: 'new', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: new Date(), updatedAt: new Date() }]) })),
    })),
    query: {
      drives: { findFirst: vi.fn() },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'id', name: 'name', slug: 'slug', ownerId: 'ownerId', isTrashed: 'isTrashed' },
}));

vi.mock('@pagespace/lib/utils/utils', () => ({
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, '-')),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({}),
  logDriveActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  listAccessibleDrives: vi.fn().mockResolvedValue([]),
}));

vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveMembership: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateMCPRequest: vi.fn(),
  isAuthError: vi.fn(() => false),
  isMCPAuthResult: vi.fn(() => false),
}));

import { POST } from '../route';
import { authenticateMCPRequest, isAuthError } from '@/lib/auth';

const mockSessionAuth = (userId = 'user-1') => ({
  userId,
  tokenType: 'mcp' as const,
  tokenVersion: 0,
  sessionId: 's1',
  role: 'user' as const,
  adminRoleVersion: 0,
  tokenId: 'tok-1',
  allowedDriveIds: [],
});

describe('POST /api/mcp/drives — reserved name guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateMCPRequest).mockResolvedValue(mockSessionAuth());
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('rejects "Home" drive name with 400', async () => {
    const req = new Request('https://example.com/api/mcp/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'Home' }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('rejects "home" drive name (case-insensitive) with 400', async () => {
    const req = new Request('https://example.com/api/mcp/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'home' }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('rejects "Personal" drive name with 400', async () => {
    const req = new Request('https://example.com/api/mcp/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'Personal' }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('allows normal drive names', async () => {
    const req = new Request('https://example.com/api/mcp/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'My Project' }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(201);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => {
  const driveRow = { id: 'drv-1', name: 'New', slug: 'new', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: new Date(), updatedAt: new Date() };
  const makeInsert = () => vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([driveRow]) })) }));
  return {
    db: {
      insert: makeInsert(),
      query: { drives: { findFirst: vi.fn() } },
      // POST /api/mcp/drives wraps insert + allocatePublishSubdomain in a transaction.
      transaction: vi.fn(async (cb: (tx: { insert: ReturnType<typeof makeInsert> }) => Promise<unknown>) => cb({ insert: makeInsert() })),
    },
  };
});

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
  allocatePublishSubdomain: vi.fn().mockResolvedValue('test-drive'),
}));

vi.mock('@pagespace/lib/agents/grant-imago-agents', () => ({
  grantImagoAgentsToOwnedDrives: vi.fn().mockResolvedValue([]),
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
import { grantImagoAgentsToOwnedDrives } from '@pagespace/lib/agents/grant-imago-agents';

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

  it('given a created drive, should grant the creator\'s Imago agents in it (DEC-2)', async () => {
    const req = new Request('https://example.com/api/mcp/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'My Project' }),
    });
    await POST(req as Parameters<typeof POST>[0]);
    expect(grantImagoAgentsToOwnedDrives).toHaveBeenCalledWith('user-1', { driveIds: ['drv-1'] });
  });

  it('given a refused name, should grant nothing', async () => {
    const req = new Request('https://example.com/api/mcp/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'Home' }),
    });
    await POST(req as Parameters<typeof POST>[0]);
    expect(grantImagoAgentsToOwnedDrives).not.toHaveBeenCalled();
  });
});

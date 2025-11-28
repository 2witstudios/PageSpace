import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: {
        findMany: vi.fn(),
      },
      driveMembers: {
        findMany: vi.fn(),
      },
    },
    select: vi.fn(),
  },
  drives: {},
  driveMembers: {},
  users: {},
  eq: vi.fn((field, value) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values, type: 'sql' })),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock drive
const mockDrive = (overrides: { id: string; name: string }) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.id,
  ownerId: 'user_123',
  createdAt: new Date(),
  updatedAt: new Date(),
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
});

describe('GET /api/account/drives-status', () => {
  const mockUserId = 'user_123';

  // Helper to setup select mock for count queries
  const setupSelectMock = (count: number) => {
    const whereMock = vi.fn().mockResolvedValue([{ count }]);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  // Helper to setup select mock for admin queries
  const setupAdminSelectMock = (admins: Array<{ id: string; name: string; email: string; role: string }>) => {
    const whereMock = vi.fn().mockResolvedValue(admins);
    const innerJoinMock = vi.fn().mockReturnValue({ where: whereMock });
    const fromMock = vi.fn().mockReturnValue({ innerJoin: innerJoinMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
      mockWebAuth(mockUserId)
    );
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default: no drives
    vi.mocked(db.query.drives.findMany).mockResolvedValue([]);
  });

  it('should return empty arrays when user owns no drives', async () => {
    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.soloDrives).toEqual([]);
    expect(body.multiMemberDrives).toEqual([]);
  });

  it('should categorize solo drive correctly', async () => {
    vi.mocked(db.query.drives.findMany).mockResolvedValue([
      mockDrive({ id: 'drive_solo', name: 'My Solo Drive' }),
    ]);

    // Mock member count to return 1 (solo)
    setupSelectMock(1);

    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.soloDrives).toHaveLength(1);
    expect(body.soloDrives[0]).toEqual({
      id: 'drive_solo',
      name: 'My Solo Drive',
      memberCount: 1,
    });
    expect(body.multiMemberDrives).toEqual([]);
  });

  it('should categorize multi-member drive correctly', async () => {
    vi.mocked(db.query.drives.findMany).mockResolvedValue([
      mockDrive({ id: 'drive_team', name: 'Team Drive' }),
    ]);

    // Mock member count to return 5 (multi-member)
    setupSelectMock(5);

    // Mock admin query
    const admins = [
      { id: 'admin_1', name: 'Admin One', email: 'admin1@example.com', role: 'ADMIN' },
      { id: 'admin_2', name: 'Admin Two', email: 'admin2@example.com', role: 'ADMIN' },
    ];

    setupAdminSelectMock(admins);

    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.soloDrives).toEqual([]);
    expect(body.multiMemberDrives).toHaveLength(1);
    expect(body.multiMemberDrives[0]).toEqual({
      id: 'drive_team',
      name: 'Team Drive',
      memberCount: 5,
      admins: [
        { id: 'admin_1', name: 'Admin One', email: 'admin1@example.com' },
        { id: 'admin_2', name: 'Admin Two', email: 'admin2@example.com' },
      ],
    });
  });

  it('should handle drive with no admins', async () => {
    vi.mocked(db.query.drives.findMany).mockResolvedValue([
      mockDrive({ id: 'drive_no_admin', name: 'No Admins Drive' }),
    ]);

    // Mock member count to return 3 (multi-member)
    setupSelectMock(3);

    // Mock empty admin list
    setupAdminSelectMock([]);

    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.multiMemberDrives[0].admins).toEqual([]);
  });

  it('should handle mixed solo and multi-member drives', async () => {
    vi.mocked(db.query.drives.findMany).mockResolvedValue([
      mockDrive({ id: 'drive_solo_1', name: 'Solo 1' }),
      mockDrive({ id: 'drive_team_1', name: 'Team 1' }),
      mockDrive({ id: 'drive_solo_2', name: 'Solo 2' }),
      mockDrive({ id: 'drive_team_2', name: 'Team 2' }),
    ]);

    // Mock member counts - alternate between 1 and 5
    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const count = callCount % 2 === 0 ? 1 : 5;
      callCount++;

      if (count === 5) {
        // Multi-member drive - return admin query mock
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                { id: 'admin_1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' },
              ]),
            }),
          }),
        } as unknown as ReturnType<typeof db.select>;
      }

      // Solo drive - return count query mock
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count }]),
        }),
      } as unknown as ReturnType<typeof db.select>;
    });

    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.soloDrives).toHaveLength(2);
    expect(body.multiMemberDrives).toHaveLength(2);
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
      mockAuthError(401)
    );

    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it('should handle database errors gracefully', async () => {
    vi.mocked(db.query.drives.findMany).mockRejectedValue(new Error('Database connection lost'));

    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to fetch drives status');
    expect(loggers.auth.error).toHaveBeenCalled();
  });

  it('should handle drive with 0 members (edge case)', async () => {
    vi.mocked(db.query.drives.findMany).mockResolvedValue([
      mockDrive({ id: 'drive_orphan', name: 'Orphan Drive' }),
    ]);

    // Mock member count to return 0
    setupSelectMock(0);

    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    // 0 members should be treated as solo (auto-delete)
    expect(body.soloDrives).toHaveLength(1);
    expect(body.multiMemberDrives).toEqual([]);
  });

  it('should correctly count multiple admins in multi-member drive', async () => {
    vi.mocked(db.query.drives.findMany).mockResolvedValue([
      mockDrive({ id: 'drive_many_admins', name: 'Many Admins Drive' }),
    ]);

    setupSelectMock(10);

    // Mock 5 admins
    const admins = Array.from({ length: 5 }, (_, i) => ({
      id: `admin_${i}`,
      name: `Admin ${i}`,
      email: `admin${i}@example.com`,
      role: 'ADMIN',
    }));

    setupAdminSelectMock(admins);

    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.multiMemberDrives[0].admins).toHaveLength(5);
  });
});

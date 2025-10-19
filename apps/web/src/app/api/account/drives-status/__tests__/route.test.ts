import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../route';

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
  and: vi.fn((...args) => ({ args, type: 'and' })),
  sql: vi.fn((strings, ...values) => ({ strings, values, type: 'sql' })),
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

describe('GET /api/account/drives-status', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: mockUserId,
      tokenVersion: 0,
    });
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
      { id: 'drive_solo', name: 'My Solo Drive' },
    ]);

    // Mock member count to return 1 (solo)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      }),
    });

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
      { id: 'drive_team', name: 'Team Drive' },
    ]);

    // Mock member count to return 5 (multi-member)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 5 }]),
      }),
    });

    // Mock admin query
    const mockAdmins = [
      {
        id: 'admin_1',
        name: 'Admin One',
        email: 'admin1@example.com',
        role: 'ADMIN',
      },
      {
        id: 'admin_2',
        name: 'Admin Two',
        email: 'admin2@example.com',
        role: 'ADMIN',
      },
    ];

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockAdmins),
        }),
      }),
    });

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
      { id: 'drive_no_admin', name: 'No Admins Drive' },
    ]);

    // Mock member count to return 3 (multi-member)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 3 }]),
      }),
    });

    // Mock empty admin list
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.multiMemberDrives[0].admins).toEqual([]);
  });

  it('should handle mixed solo and multi-member drives', async () => {
    vi.mocked(db.query.drives.findMany).mockResolvedValue([
      { id: 'drive_solo_1', name: 'Solo 1' },
      { id: 'drive_team_1', name: 'Team 1' },
      { id: 'drive_solo_2', name: 'Solo 2' },
      { id: 'drive_team_2', name: 'Team 2' },
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
        } as any;
      }

      // Solo drive - return count query mock
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count }]),
        }),
      } as any;
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
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

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
      { id: 'drive_orphan', name: 'Orphan Drive' },
    ]);

    // Mock member count to return 0
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      }),
    });

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
      { id: 'drive_many_admins', name: 'Many Admins Drive' },
    ]);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 10 }]),
      }),
    });

    // Mock 5 admins
    const mockAdmins = Array.from({ length: 5 }, (_, i) => ({
      id: `admin_${i}`,
      name: `Admin ${i}`,
      email: `admin${i}@example.com`,
      role: 'ADMIN' as const,
    }));

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockAdmins),
        }),
      }),
    });

    const request = new Request('https://example.com/api/account/drives-status');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.multiMemberDrives[0].admins).toHaveLength(5);
  });
});

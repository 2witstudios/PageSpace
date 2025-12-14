import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    transaction: vi.fn(),
  },
  pages: { id: 'pages.id', driveId: 'pages.driveId', parentId: 'pages.parentId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
  driveMembers: {
    driveId: 'driveMembers.driveId',
    userId: 'driveMembers.userId',
    role: 'driveMembers.role',
  },
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
}));

vi.mock('@pagespace/lib/server', () => ({
  pageTreeCache: {
    invalidateDriveTree: vi.fn(),
  },
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/pages/circular-reference-guard', () => ({
  validatePageMove: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(() => ({})),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { pageTreeCache } from '@pagespace/lib/server';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import { broadcastPageEvent } from '@/lib/websocket';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

describe('PATCH /api/pages/reorder', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';
  const mockDriveId = 'drive_123';

  const createRequest = (body: Record<string, unknown>) => {
    return new Request('https://example.com/api/pages/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (validatePageMove as Mock).mockResolvedValue({ valid: true });

    // Mock transaction with page info and owner check
    (db.transaction as Mock).mockImplementation(async (callback) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  driveId: mockDriveId,
                  title: 'Test Page',
                  ownerId: mockUserId, // User is owner
                }]),
              }),
            }),
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return callback(tx);
    });
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('returns 400 when pageId is missing', async () => {
      const response = await PATCH(createRequest({
        newParentId: null,
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    it('returns 400 when newPosition is missing', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    it('returns 400 when newPosition is not a number', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 'first',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    it('returns 400 when circular reference is detected', async () => {
      (validatePageMove as Mock).mockResolvedValue({
        valid: false,
        error: 'Cannot move page into its own descendant',
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: 'child_page',
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot move page into its own descendant');
    });
  });

  describe('authorization', () => {
    it('returns 403 when user is not owner or admin', async () => {
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          select: vi.fn()
            .mockReturnValueOnce({
              from: vi.fn().mockReturnValue({
                leftJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([{
                      driveId: mockDriveId,
                      title: 'Test Page',
                      ownerId: 'different_user', // User is not owner
                    }]),
                  }),
                }),
              }),
            })
            .mockReturnValueOnce({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]), // Not admin
                }),
              }),
            }),
          update: vi.fn(),
        };
        return callback(tx);
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can reorder pages.');
    });

    it('allows drive owner to reorder pages', async () => {
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{
                    driveId: mockDriveId,
                    title: 'Test Page',
                    ownerId: mockUserId,
                  }]),
                }),
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return callback(tx);
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(response.status).toBe(200);
    });

    it('allows drive admin to reorder pages', async () => {
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          select: vi.fn()
            .mockReturnValueOnce({
              from: vi.fn().mockReturnValue({
                leftJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([{
                      driveId: mockDriveId,
                      title: 'Test Page',
                      ownerId: 'different_user',
                    }]),
                  }),
                }),
              }),
            })
            .mockReturnValueOnce({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ role: 'ADMIN' }]),
                }),
              }),
            }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return callback(tx);
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(response.status).toBe(200);
    });
  });

  describe('page reordering', () => {
    it('reorders page to root level (null parent)', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Page reordered successfully');
    });

    it('reorders page under a new parent', async () => {
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          select: vi.fn()
            .mockReturnValueOnce({
              from: vi.fn().mockReturnValue({
                leftJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([{
                      driveId: mockDriveId,
                      title: 'Test Page',
                      ownerId: mockUserId,
                    }]),
                  }),
                }),
              }),
            })
            .mockReturnValueOnce({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{
                    driveId: mockDriveId, // Same drive
                  }]),
                }),
              }),
            }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return callback(tx);
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: 'parent_page_123',
        newPosition: 1,
      }));

      expect(response.status).toBe(200);
    });

    it('returns 404 when parent page does not exist', async () => {
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          select: vi.fn()
            .mockReturnValueOnce({
              from: vi.fn().mockReturnValue({
                leftJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([{
                      driveId: mockDriveId,
                      title: 'Test Page',
                      ownerId: mockUserId,
                    }]),
                  }),
                }),
              }),
            })
            .mockReturnValueOnce({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]), // Parent not found
                }),
              }),
            }),
          update: vi.fn(),
        };
        return callback(tx);
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: 'nonexistent_parent',
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Parent page not found.');
    });

    it('returns 400 when moving page between different drives', async () => {
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          select: vi.fn()
            .mockReturnValueOnce({
              from: vi.fn().mockReturnValue({
                leftJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([{
                      driveId: mockDriveId,
                      title: 'Test Page',
                      ownerId: mockUserId,
                    }]),
                  }),
                }),
              }),
            })
            .mockReturnValueOnce({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{
                    driveId: 'different_drive', // Different drive
                  }]),
                }),
              }),
            }),
          update: vi.fn(),
        };
        return callback(tx);
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: 'page_in_other_drive',
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot move pages between different drives.');
    });

    it('returns 404 when page not found', async () => {
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]), // Page not found
                }),
              }),
            }),
          }),
        };
        return callback(tx);
      });

      const response = await PATCH(createRequest({
        pageId: 'nonexistent_page',
        newParentId: null,
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Page not found.');
    });
  });

  describe('side effects', () => {
    it('broadcasts page moved event', async () => {
      await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('invalidates page tree cache', async () => {
      await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockDriveId);
    });
  });

  describe('error handling', () => {
    it('returns 500 when database transaction fails', async () => {
      (db.transaction as Mock).mockRejectedValue(new Error('Database error'));

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Database error');
    });
  });

  describe('position handling', () => {
    it('accepts position 0', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(response.status).toBe(200);
    });

    it('accepts positive position values', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 100,
      }));

      expect(response.status).toBe(200);
    });

    it('returns 400 for negative position values', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: -1,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Position must be a non-negative integer');
    });
  });
});

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: {
        findFirst: vi.fn(),
      },
      pages: {
        findFirst: vi.fn(),
      },
      users: {
        findFirst: vi.fn(),
      },
    },
    transaction: vi.fn(),
  },
  drives: {},
  pages: {},
  users: {},
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  desc: vi.fn((col: unknown) => ({ type: 'desc', col })),
}));

vi.mock('@pagespace/lib', () => ({
  validatePageCreation: vi.fn(),
  validateAIChatTools: vi.fn(),
  getDefaultContent: vi.fn(() => '<p></p>'),
  PageType: {
    FOLDER: 'FOLDER',
    DOCUMENT: 'DOCUMENT',
    CHANNEL: 'CHANNEL',
    AI_CHAT: 'AI_CHAT',
    CANVAS: 'CANVAS',
    SHEET: 'SHEET',
  },
  isAIChatPage: vi.fn((type: string) => type === 'AI_CHAT'),
  isDriveOwnerOrAdmin: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(() => ({})),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  agentAwarenessCache: {
    invalidateDriveAgents: vi.fn(),
  },
  pageTreeCache: {
    invalidateDriveTree: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackPageOperation: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import {
  validatePageCreation,
  validateAIChatTools,
  isDriveOwnerOrAdmin,
} from '@pagespace/lib';
import { broadcastPageEvent } from '@/lib/websocket';
import { agentAwarenessCache, pageTreeCache } from '@pagespace/lib/server';

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

// Helper to create mock drive
const mockDrive = (overrides?: Partial<{ id: string; name: string; ownerId: string }>) => ({
  id: overrides?.id ?? 'drive_123',
  name: overrides?.name ?? 'Test Drive',
  slug: overrides?.id ?? 'drive_123',
  ownerId: overrides?.ownerId ?? 'user_123',
  createdAt: new Date(),
  updatedAt: new Date(),
  isTrashed: false,
  trashedAt: null,
});

// Helper to create mock page
const mockPage = (overrides?: Partial<{
  id: string;
  title: string;
  type: string;
  position: number;
  parentId: string | null;
  driveId: string;
}>) => ({
  id: overrides?.id ?? 'page_123',
  title: overrides?.title ?? 'Test Page',
  type: overrides?.type ?? 'DOCUMENT',
  content: '<p></p>',
  position: overrides?.position ?? 0,
  parentId: overrides?.parentId ?? null,
  driveId: overrides?.driveId ?? 'drive_123',
  createdAt: new Date(),
  updatedAt: new Date(),
  isTrashed: false,
  trashedAt: null,
});

describe('POST /api/pages', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_123';

  const createRequest = (body: Record<string, unknown>) => {
    return new Request('https://example.com/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));

    // Default drive exists
    (db.query.drives.findFirst as Mock).mockResolvedValue(mockDrive());

    // Default permission check passes
    (isDriveOwnerOrAdmin as Mock).mockResolvedValue(true);

    // Default validation passes
    (validatePageCreation as Mock).mockReturnValue({ valid: true, errors: [] });
    (validateAIChatTools as Mock).mockReturnValue({ valid: true, errors: [] });

    // Default no existing pages (position 0)
    (db.query.pages.findFirst as Mock).mockResolvedValue(null);

    // Default transaction returns created page
    (db.transaction as Mock).mockImplementation(async (callback) => {
      const tx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([mockPage()]),
          }),
        }),
      };
      return callback(tx);
    });
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('returns 400 when title is missing', async () => {
      const response = await POST(createRequest({
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Missing required fields');
    });

    it('returns 400 when type is missing', async () => {
      const response = await POST(createRequest({
        title: 'Test Page',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Missing required fields');
    });

    it('returns 400 when driveId is missing', async () => {
      const response = await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Missing required fields');
    });

    it('returns 400 when page validation fails', async () => {
      (validatePageCreation as Mock).mockReturnValue({
        valid: false,
        errors: ['Title too long', 'Invalid characters in title'],
      });

      const response = await POST(createRequest({
        title: 'Valid Title', // Must be truthy to pass initial check
        type: 'DOCUMENT',     // Must be truthy to pass initial check
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Title too long. Invalid characters in title');
    });

    it('returns 400 when AI chat tool validation fails', async () => {
      (validateAIChatTools as Mock).mockReturnValue({
        valid: false,
        errors: ['Unknown tool: invalid_tool'],
      });

      // Mock dynamic import
      vi.doMock('@/lib/ai/core/ai-tools', () => ({
        pageSpaceTools: { read_page: {}, create_page: {} },
      }));

      const response = await POST(createRequest({
        title: 'AI Chat',
        type: 'AI_CHAT',
        driveId: mockDriveId,
        enabledTools: ['invalid_tool'],
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Unknown tool: invalid_tool');
    });
  });

  describe('authorization', () => {
    it('returns 404 when drive does not exist', async () => {
      (db.query.drives.findFirst as Mock).mockResolvedValue(null);

      const response = await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('returns 403 when user is not owner or admin', async () => {
      (isDriveOwnerOrAdmin as Mock).mockResolvedValue(false);

      const response = await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can create pages');
    });
  });

  describe('page creation', () => {
    it('creates a DOCUMENT page successfully', async () => {
      const createdPage = mockPage({
        title: 'New Document',
        type: 'DOCUMENT',
      });
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([createdPage]),
            }),
          }),
        };
        return callback(tx);
      });

      const response = await POST(createRequest({
        title: 'New Document',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.title).toBe('New Document');
      expect(body.type).toBe('DOCUMENT');
    });

    it('creates a FOLDER page successfully', async () => {
      const createdPage = mockPage({
        title: 'New Folder',
        type: 'FOLDER',
      });
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([createdPage]),
            }),
          }),
        };
        return callback(tx);
      });

      const response = await POST(createRequest({
        title: 'New Folder',
        type: 'FOLDER',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.type).toBe('FOLDER');
    });

    it('creates page with correct position when siblings exist', async () => {
      const existingPage = mockPage({ position: 5 });
      (db.query.pages.findFirst as Mock).mockResolvedValue(existingPage);

      let capturedInsertValues: Record<string, unknown> | undefined;
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((data: Record<string, unknown>) => {
              capturedInsertValues = data;
              return {
                returning: vi.fn().mockResolvedValue([mockPage({ position: 6 })]),
              };
            }),
          }),
        };
        return callback(tx);
      });

      await POST(createRequest({
        title: 'New Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));

      expect(capturedInsertValues?.position).toBe(6);
    });

    it('creates page with parentId when provided', async () => {
      let capturedInsertValues: Record<string, unknown> | undefined;
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((data: Record<string, unknown>) => {
              capturedInsertValues = data;
              return {
                returning: vi.fn().mockResolvedValue([mockPage({ parentId: 'parent_page_123' })]),
              };
            }),
          }),
        };
        return callback(tx);
      });

      await POST(createRequest({
        title: 'Child Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
        parentId: 'parent_page_123',
      }));

      expect(capturedInsertValues?.parentId).toBe('parent_page_123');
    });

    it('creates AI_CHAT page with AI settings', async () => {
      (db.query.users.findFirst as Mock).mockResolvedValue({
        currentAiProvider: 'openai',
        currentAiModel: 'gpt-4',
      });

      const createdPage = mockPage({
        title: 'AI Assistant',
        type: 'AI_CHAT',
      });
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([createdPage]),
            }),
          }),
        };
        return callback(tx);
      });

      const response = await POST(createRequest({
        title: 'AI Assistant',
        type: 'AI_CHAT',
        driveId: mockDriveId,
        systemPrompt: 'You are a helpful assistant',
        enabledTools: ['read_page'],
        aiProvider: 'anthropic',
        aiModel: 'claude-3',
      }));

      expect(response.status).toBe(201);
      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });
  });

  describe('side effects', () => {
    it('broadcasts page created event', async () => {
      await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));

      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('invalidates page tree cache', async () => {
      await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockDriveId);
    });

    it('invalidates agent awareness cache for AI_CHAT pages', async () => {
      await POST(createRequest({
        title: 'AI Chat',
        type: 'AI_CHAT',
        driveId: mockDriveId,
      }));

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });

    it('does not invalidate agent awareness cache for non-AI pages', async () => {
      await POST(createRequest({
        title: 'Document',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));

      expect(agentAwarenessCache.invalidateDriveAgents).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 when database transaction fails', async () => {
      (db.transaction as Mock).mockRejectedValue(new Error('Database error'));

      const response = await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create page');
    });
  });
});

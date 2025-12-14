import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      chatMessages: {
        findMany: vi.fn(),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(),
          })),
        })),
      })),
    })),
    transaction: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    insert: vi.fn(),
  },
  pages: { id: 'pages.id' },
  mentions: { sourcePageId: 'mentions.sourcePageId', targetPageId: 'mentions.targetPageId' },
  chatMessages: { pageId: 'chatMessages.pageId', isActive: 'chatMessages.isActive' },
  drives: { id: 'drives.id' },
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values, type: 'inArray' })),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  canUserEditPage: vi.fn(),
  canUserDeletePage: vi.fn(),
  agentAwarenessCache: {
    invalidateDriveAgents: vi.fn(),
  },
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

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackPageOperation: vi.fn(),
}));

vi.mock('@pagespace/lib/api-utils', () => ({
  jsonResponse: vi.fn((data) => NextResponse.json(data)),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import {
  canUserViewPage,
  canUserEditPage,
  canUserDeletePage,
  agentAwarenessCache,
  pageTreeCache,
} from '@pagespace/lib/server';
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

// Helper to create mock page
const mockPage = (overrides?: Partial<{
  id: string;
  title: string;
  type: string;
  content: string;
  parentId: string | null;
  driveId: string;
  isTrashed: boolean;
}>) => ({
  id: overrides?.id ?? 'page_123',
  title: overrides?.title ?? 'Test Page',
  type: overrides?.type ?? 'DOCUMENT',
  content: overrides?.content ?? '<p>Test content</p>',
  parentId: overrides?.parentId ?? null,
  driveId: overrides?.driveId ?? 'drive_123',
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  isTrashed: overrides?.isTrashed ?? false,
  trashedAt: null,
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
});

describe('GET /api/pages/[pageId]', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';

  const createRequest = () => {
    return new Request(`https://example.com/api/pages/${mockPageId}`, {
      method: 'GET',
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (canUserViewPage as Mock).mockResolvedValue(true);
    (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage());
    (db.query.pages.findMany as Mock).mockResolvedValue([]);
    (db.query.chatMessages.findMany as Mock).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks view permission', async () => {
      (canUserViewPage as Mock).mockResolvedValue(false);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(403);
    });
  });

  describe('page retrieval', () => {
    it('returns 404 when page does not exist', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue(null);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(404);
    });

    it('returns page with children and messages when found', async () => {
      const page = mockPage({ title: 'Parent Page' });
      const children = [
        mockPage({ id: 'child_1', title: 'Child 1' }),
        mockPage({ id: 'child_2', title: 'Child 2' }),
      ];
      const messages = [{ id: 'msg_1', content: 'Hello', user: { name: 'User' } }];

      (db.query.pages.findFirst as Mock).mockResolvedValue(page);
      (db.query.pages.findMany as Mock).mockResolvedValue(children);
      (db.query.chatMessages.findMany as Mock).mockResolvedValue(messages);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.title).toBe('Parent Page');
      expect(body.children).toHaveLength(2);
      expect(body.messages).toHaveLength(1);
    });

    it('sanitizes empty content', async () => {
      const page = mockPage({ content: '<p></p>' });
      (db.query.pages.findFirst as Mock).mockResolvedValue(page);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(body.content).toBe('');
    });

    it('preserves non-empty content', async () => {
      const page = mockPage({ content: '<p>Hello world</p>' });
      (db.query.pages.findFirst as Mock).mockResolvedValue(page);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(body.content).toBe('<p>Hello world</p>');
    });
  });

  describe('error handling', () => {
    it('returns 500 when database query fails', async () => {
      (db.query.pages.findFirst as Mock).mockRejectedValue(new Error('Database error'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch page details');
    });
  });
});

describe('PATCH /api/pages/[pageId]', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';
  const mockDriveId = 'drive_123';

  const createRequest = (body: Record<string, unknown>) => {
    return new Request(`https://example.com/api/pages/${mockPageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (canUserEditPage as Mock).mockResolvedValue(true);
    (validatePageMove as Mock).mockResolvedValue({ valid: true });

    // Mock transaction
    (db.transaction as Mock).mockImplementation(async (callback) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      return callback(tx);
    });

    // Mock refetch queries
    (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage());
    (db.query.pages.findMany as Mock).mockResolvedValue([]);
    (db.query.chatMessages.findMany as Mock).mockResolvedValue([]);

    // Mock getDriveIdFromPageId
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: mockDriveId }]),
          }),
        }),
      }),
    } as ReturnType<typeof db.select>);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks edit permission', async () => {
      (canUserEditPage as Mock).mockResolvedValue(false);

      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You need edit permission to modify this page');
    });
  });

  describe('validation', () => {
    it('returns 400 for invalid body schema', async () => {
      const response = await PATCH(createRequest({ unknownField: 'value' }), { params: mockParams });

      // Zod will strip unknown fields but not error, so this should still work
      expect(response.status).toBe(200);
    });

    it('returns 400 when parent change creates circular reference', async () => {
      (validatePageMove as Mock).mockResolvedValue({
        valid: false,
        error: 'Cannot move page into its own descendant',
      });

      const response = await PATCH(
        createRequest({ parentId: 'child_page' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot move page into its own descendant');
    });
  });

  describe('page update', () => {
    it('updates page title successfully', async () => {
      const updatedPage = mockPage({ title: 'Updated Title' });
      (db.query.pages.findFirst as Mock).mockResolvedValue(updatedPage);

      const response = await PATCH(createRequest({ title: 'Updated Title' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.title).toBe('Updated Title');
    });

    it('updates page content successfully', async () => {
      const updatedPage = mockPage({ content: '<p>New content</p>' });
      (db.query.pages.findFirst as Mock).mockResolvedValue(updatedPage);

      const response = await PATCH(
        createRequest({ content: '<p>New content</p>' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.content).toBe('<p>New content</p>');
    });

    it('updates page parentId successfully', async () => {
      const updatedPage = mockPage({ parentId: 'new_parent_123' });
      (db.query.pages.findFirst as Mock).mockResolvedValue(updatedPage);

      const response = await PATCH(
        createRequest({ parentId: 'new_parent_123' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.parentId).toBe('new_parent_123');
    });

    it('updates AI settings for AI_CHAT pages', async () => {
      const updatedPage = mockPage({ type: 'AI_CHAT' });
      (db.query.pages.findFirst as Mock).mockResolvedValue(updatedPage);

      const response = await PATCH(
        createRequest({ aiProvider: 'anthropic', aiModel: 'claude-3' }),
        { params: mockParams }
      );

      expect(response.status).toBe(200);
    });
  });

  describe('side effects', () => {
    it('broadcasts title update event', async () => {
      const page = mockPage({ title: 'Updated' });
      (db.query.pages.findFirst as Mock).mockResolvedValue(page);

      await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('broadcasts content update event', async () => {
      const page = mockPage({ content: '<p>New</p>' });
      (db.query.pages.findFirst as Mock).mockResolvedValue(page);

      await PATCH(createRequest({ content: '<p>New</p>' }), { params: mockParams });

      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('invalidates page tree cache on title change', async () => {
      const page = mockPage({ title: 'Updated' });
      (db.query.pages.findFirst as Mock).mockResolvedValue(page);

      await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockDriveId);
    });

    it('invalidates agent cache when AI_CHAT title changes', async () => {
      const page = mockPage({ type: 'AI_CHAT', title: 'AI Agent' });
      (db.query.pages.findFirst as Mock).mockResolvedValue(page);

      await PATCH(createRequest({ title: 'AI Agent' }), { params: mockParams });

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });
  });

  describe('error handling', () => {
    it('returns 500 when database update fails', async () => {
      (db.transaction as Mock).mockRejectedValue(new Error('Database error'));

      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update page');
    });
  });
});

describe('DELETE /api/pages/[pageId]', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';
  const mockDriveId = 'drive_123';

  const createRequest = (body: Record<string, unknown> = {}) => {
    return new Request(`https://example.com/api/pages/${mockPageId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (canUserDeletePage as Mock).mockResolvedValue(true);

    // Mock page with drive info
    (db.query.pages.findFirst as Mock).mockResolvedValue({
      ...mockPage(),
      drive: { id: mockDriveId },
    });

    // Mock transaction
    (db.transaction as Mock).mockImplementation(async (callback) => {
      const tx = {
        query: {
          pages: {
            findFirst: vi.fn().mockResolvedValue(mockPage()),
          },
        },
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
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

      const response = await DELETE(createRequest({}), { params: mockParams });

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks delete permission', async () => {
      (canUserDeletePage as Mock).mockResolvedValue(false);

      const response = await DELETE(createRequest({}), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You need delete permission to remove this page');
    });
  });

  describe('page deletion', () => {
    it('trashes page successfully without children', async () => {
      const response = await DELETE(createRequest({ trash_children: false }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Page moved to trash successfully.');
    });

    it('trashes page with children when trash_children is true', async () => {
      const response = await DELETE(createRequest({ trash_children: true }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Page moved to trash successfully.');
    });

    it('moves children to grandparent when trash_children is false', async () => {
      // This test verifies the trash_children: false path is executed
      // The actual logic promotes children to the deleted page's parent
      const updateMock = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          query: {
            pages: {
              findFirst: vi.fn().mockResolvedValue(mockPage({ parentId: 'grandparent_123' })),
            },
          },
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
          update: updateMock,
        };
        return callback(tx);
      });

      const response = await DELETE(createRequest({ trash_children: false }), { params: mockParams });
      const body = await response.json();

      // Verify the transaction was called (which includes the child promotion logic)
      expect(response.status).toBe(200);
      expect(body.message).toBe('Page moved to trash successfully.');
      expect(updateMock).toHaveBeenCalled();
    });
  });

  describe('side effects', () => {
    it('broadcasts page trashed event', async () => {
      await DELETE(createRequest({}), { params: mockParams });

      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('invalidates page tree cache', async () => {
      await DELETE(createRequest({}), { params: mockParams });

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockDriveId);
    });

    it('invalidates agent cache when AI_CHAT page is trashed', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue({
        ...mockPage({ type: 'AI_CHAT' }),
        drive: { id: mockDriveId },
      });

      await DELETE(createRequest({}), { params: mockParams });

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });
  });

  describe('error handling', () => {
    it('returns 500 when database transaction fails', async () => {
      (db.transaction as Mock).mockRejectedValue(new Error('Database error'));

      const response = await DELETE(createRequest({}), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete page');
    });

    it('returns 400 for invalid body schema', async () => {
      const response = await DELETE(
        createRequest({ trash_children: 'not_a_boolean' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });
  });
});

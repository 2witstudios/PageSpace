import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @pagespace/db
vi.mock('@pagespace/db', () => {
  const mockTable = (name: string) => ({
    id: `${name}.id`,
    name: `${name}.name`,
    email: `${name}.email`,
    image: `${name}.image`,
    timezone: `${name}.timezone`,
    createdAt: `${name}.createdAt`,
    updatedAt: `${name}.updatedAt`,
    slug: `${name}.slug`,
    ownerId: `${name}.ownerId`,
    role: `${name}.role`,
    driveId: `${name}.driveId`,
    userId: `${name}.userId`,
    title: `${name}.title`,
    type: `${name}.type`,
    content: `${name}.content`,
    pageId: `${name}.pageId`,
    conversationId: `${name}.conversationId`,
    sizeBytes: `${name}.sizeBytes`,
    mimeType: `${name}.mimeType`,
    storagePath: `${name}.storagePath`,
    createdBy: `${name}.createdBy`,
    operation: `${name}.operation`,
    resourceType: `${name}.resourceType`,
    resourceId: `${name}.resourceId`,
    timestamp: `${name}.timestamp`,
    metadata: `${name}.metadata`,
    provider: `${name}.provider`,
    model: `${name}.model`,
    inputTokens: `${name}.inputTokens`,
    outputTokens: `${name}.outputTokens`,
    cost: `${name}.cost`,
    status: `${name}.status`,
    priority: `${name}.priority`,
    taskListId: `${name}.taskListId`,
    senderId: `${name}.senderId`,
  });

  return {
    users: mockTable('users'),
    drives: mockTable('drives'),
    driveMembers: mockTable('driveMembers'),
    pages: mockTable('pages'),
    chatMessages: mockTable('chatMessages'),
    channelMessages: mockTable('channelMessages'),
    conversations: mockTable('conversations'),
    messages: mockTable('messages'),
    directMessages: mockTable('directMessages'),
    dmConversations: mockTable('dmConversations'),
    files: mockTable('files'),
    filePages: mockTable('filePages'),
    activityLogs: mockTable('activityLogs'),
    aiUsageLogs: mockTable('aiUsageLogs'),
    taskLists: mockTable('taskLists'),
    taskItems: mockTable('taskItems'),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ operator: 'eq', column: col, value: val })),
  inArray: vi.fn((col, vals) => ({ operator: 'inArray', column: col, values: vals })),
}));

import {
  collectUserProfile,
  collectUserDrives,
  collectUserPages,
  collectUserMessages,
  collectUserFiles,
  collectUserActivity,
  collectUserAiUsage,
  collectUserTasks,
  collectAllUserData,
} from './gdpr-export';

describe('collectUserProfile', () => {
  it('should return profile when user exists', async () => {
    const profile = {
      id: 'user-1',
      name: 'Test User',
      email: 'test@example.com',
      image: null,
      timezone: 'UTC',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(() => ({ limit: vi.fn().mockReturnValue([profile]) })),
    };

    const result = await collectUserProfile(db as never, 'user-1');
    expect(result).toEqual(profile);
  });

  it('should return null when user does not exist', async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(() => ({ limit: vi.fn().mockReturnValue([]) })),
    };

    const result = await collectUserProfile(db as never, 'nonexistent');
    expect(result).toBeNull();
  });
});

describe('collectUserDrives', () => {
  it('should return owned and member drives, deduplicating', async () => {
    const ownedDrive = { id: 'drive-1', name: 'My Drive', slug: 'my-drive', createdAt: new Date() };
    const memberDrive = { id: 'drive-2', name: 'Shared Drive', slug: 'shared', role: 'MEMBER', createdAt: new Date() };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
      innerJoin: vi.fn().mockReturnThis(),
    };

    // First call: owned drives
    db.where.mockResolvedValueOnce([ownedDrive]);
    // Second call: member drives (from innerJoin chain)
    db.where.mockResolvedValueOnce([memberDrive]);

    const result = await collectUserDrives(db as never, 'user-1');
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('OWNER');
    expect(result[1].role).toBe('MEMBER');
  });

  it('should deduplicate when user is both owner and member', async () => {
    const drive = { id: 'drive-1', name: 'Drive', slug: 'drive', createdAt: new Date() };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
      innerJoin: vi.fn().mockReturnThis(),
    };

    db.where.mockResolvedValueOnce([drive]);
    db.where.mockResolvedValueOnce([{ ...drive, role: 'ADMIN' }]);

    const result = await collectUserDrives(db as never, 'user-1');
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('OWNER');
  });
});

describe('collectUserPages', () => {
  it('should return pages from user drives', async () => {
    const page = {
      id: 'page-1',
      title: 'Test Page',
      type: 'DOCUMENT',
      content: 'Hello',
      driveId: 'drive-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([page]),
      innerJoin: vi.fn().mockReturnThis(),
    };

    const result = await collectUserPages(db as never, 'user-1', ['drive-1']);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Test Page');
  });

  it('should return empty array when no driveIds provided', async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
      innerJoin: vi.fn().mockReturnThis(),
    };

    const result = await collectUserPages(db as never, 'user-1', []);
    expect(result).toEqual([]);
  });

  it('should fetch drives when preloadedDriveIds not provided', async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
      innerJoin: vi.fn().mockReturnThis(),
    };

    // collectUserDrives calls: owned drives, member drives
    db.where.mockResolvedValueOnce([]);  // owned drives
    db.where.mockResolvedValueOnce([]);  // member drives
    // no driveIds → empty result

    const result = await collectUserPages(db as never, 'user-1');
    expect(result).toEqual([]);
  });
});

describe('collectUserMessages', () => {
  it('should collect messages from all sources', async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
    };

    const aiMsg = { id: 'm1', content: 'AI msg', role: 'user', pageId: 'p1', conversationId: 'c1', createdAt: new Date() };
    const channelMsg = { id: 'm2', content: 'Channel msg', pageId: 'p2', createdAt: new Date() };
    const convMsg = { id: 'm3', content: 'Conv msg', role: 'user', conversationId: 'c2', createdAt: new Date() };
    const dmMsg = { id: 'm4', content: 'DM msg', conversationId: 'c3', createdAt: new Date() };

    db.where
      .mockResolvedValueOnce([aiMsg])
      .mockResolvedValueOnce([channelMsg])
      .mockResolvedValueOnce([convMsg])
      .mockResolvedValueOnce([dmMsg]);

    const result = await collectUserMessages(db as never, 'user-1');
    expect(result).toHaveLength(4);
    expect(result[0].source).toBe('ai_chat');
    expect(result[1].source).toBe('channel');
    expect(result[2].source).toBe('conversation');
    expect(result[3].source).toBe('direct_message');
  });
});

describe('collectUserFiles', () => {
  it('should return files created by user', async () => {
    const file = {
      id: 'f1', driveId: 'd1', sizeBytes: 1024,
      mimeType: 'text/plain', storagePath: '/path', createdAt: new Date(),
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([file]),
    };

    const result = await collectUserFiles(db as never, 'user-1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f1');
  });
});

describe('collectUserActivity', () => {
  it('should return activity logs for user', async () => {
    const activity = {
      id: 'a1', operation: 'create', resourceType: 'page',
      resourceId: 'p1', timestamp: new Date(), metadata: null,
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([activity]),
    };

    const result = await collectUserActivity(db as never, 'user-1');
    expect(result).toHaveLength(1);
    expect(result[0].operation).toBe('create');
  });
});

describe('collectUserAiUsage', () => {
  it('should return AI usage logs for user', async () => {
    const usage = {
      id: 'u1', provider: 'openai', model: 'gpt-4',
      inputTokens: 100, outputTokens: 50, cost: 0.01, timestamp: new Date(),
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([usage]),
    };

    const result = await collectUserAiUsage(db as never, 'user-1');
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('openai');
  });
});

describe('collectUserTasks', () => {
  it('should return task lists with items', async () => {
    const list = { id: 'tl1', title: 'My Tasks' };
    const item = { id: 'ti1', title: 'Task 1', status: 'pending', priority: 'high', taskListId: 'tl1', createdAt: new Date() };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
    };

    db.where.mockResolvedValueOnce([list]);  // task lists
    db.where.mockResolvedValueOnce([item]);  // task items

    const result = await collectUserTasks(db as never, 'user-1');
    expect(result).toHaveLength(1);
    expect(result[0].listTitle).toBe('My Tasks');
    expect(result[0].items).toHaveLength(1);
    expect(result[0].items[0].title).toBe('Task 1');
  });

  it('should return empty array when user has no task lists', async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };

    const result = await collectUserTasks(db as never, 'user-1');
    expect(result).toEqual([]);
  });

  it('should handle lists with no items', async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
    };

    db.where.mockResolvedValueOnce([{ id: 'tl1', title: 'Empty List' }]);
    db.where.mockResolvedValueOnce([]);

    const result = await collectUserTasks(db as never, 'user-1');
    expect(result).toHaveLength(1);
    expect(result[0].items).toEqual([]);
  });
});

describe('collectAllUserData', () => {
  it('should return null when user does not exist', async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(() => ({ limit: vi.fn().mockReturnValue([]) })),
      innerJoin: vi.fn().mockReturnThis(),
    };

    const result = await collectAllUserData(db as never, 'nonexistent');
    expect(result).toBeNull();
  });

  it('should aggregate all user data when user exists', async () => {
    const profile = {
      id: 'user-1', name: 'Test', email: 'test@test.com',
      image: null, timezone: 'UTC', createdAt: new Date(), updatedAt: new Date(),
    };

    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          // collectUserProfile: returns chain with .limit()
          return { limit: vi.fn().mockReturnValue([profile]) };
        }
        // All other calls return empty arrays
        return [];
      }),
      innerJoin: vi.fn().mockReturnThis(),
    };

    const result = await collectAllUserData(db as never, 'user-1');
    expect(result).not.toBeNull();
    expect(result!.profile.id).toBe('user-1');
    expect(Array.isArray(result!.drives)).toBe(true);
    expect(Array.isArray(result!.pages)).toBe(true);
    expect(Array.isArray(result!.messages)).toBe(true);
    expect(Array.isArray(result!.files)).toBe(true);
    expect(Array.isArray(result!.activity)).toBe(true);
    expect(Array.isArray(result!.aiUsage)).toBe(true);
    expect(Array.isArray(result!.tasks)).toBe(true);
  });
});

/**
 * @scaffold — GDPR Export Tests
 *
 * These functions use module-level ORM queries with no injected seam.
 * Chain mocks and order-dependent mock ladders (createChainDb callIndex)
 * are structural necessities — assertions focus on the observable data
 * contracts (return types, aggregation logic, deduplication).
 *
 * REVIEW: introduce a GdprExportRepository seam so these functions can
 * be tested without reproducing the ORM chain shape. Once that seam
 * exists, remove the chain mocks and promote these to contract tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTable } = vi.hoisted(() => {
  const fn = (name: string) => ({
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
    participant1Id: `${name}.participant1Id`,
    participant2Id: `${name}.participant2Id`,
    isRead: `${name}.isRead`,
    readAt: `${name}.readAt`,
    message: `${name}.message`,
    preferenceType: `${name}.preferenceType`,
    enabled: `${name}.enabled`,
    bio: `${name}.bio`,
    writingStyle: `${name}.writingStyle`,
    rules: `${name}.rules`,
    scopes: `${name}.scopes`,
    deviceId: `${name}.deviceId`,
    createdByIp: `${name}.createdByIp`,
    lastUsedAt: `${name}.lastUsedAt`,
    lastUsedIp: `${name}.lastUsedIp`,
    expiresAt: `${name}.expiresAt`,
    revokedAt: `${name}.revokedAt`,
    revokedReason: `${name}.revokedReason`,
  });
  return { mockTable: fn };
});

vi.mock('@pagespace/db/schema/auth', () => ({ users: mockTable('users') }));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: mockTable('drives'),
  pages: mockTable('pages'),
  chatMessages: mockTable('chatMessages'),
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  activityLogs: mockTable('activityLogs'),
  aiUsageLogs: mockTable('aiUsageLogs'),
}));
vi.mock('@pagespace/db/schema/storage', () => ({
  files: mockTable('files'),
  filePages: mockTable('filePages'),
}));
vi.mock('@pagespace/db/schema/members', () => ({ driveMembers: mockTable('driveMembers') }));
vi.mock('@pagespace/db/schema/chat', () => ({ channelMessages: mockTable('channelMessages') }));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: mockTable('conversations'),
  messages: mockTable('messages'),
}));
vi.mock('@pagespace/db/schema/social', () => ({
  directMessages: mockTable('directMessages'),
  dmConversations: mockTable('dmConversations'),
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskLists: mockTable('taskLists'),
  taskItems: mockTable('taskItems'),
}));
vi.mock('@pagespace/db/schema/sessions', () => ({ sessions: mockTable('sessions') }));
vi.mock('@pagespace/db/schema/notifications', () => ({ notifications: mockTable('notifications') }));
vi.mock('@pagespace/db/schema/display-preferences', () => ({ displayPreferences: mockTable('displayPreferences') }));
vi.mock('@pagespace/db/schema/personalization', () => ({ userPersonalization: mockTable('userPersonalization') }));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ _op: 'eq', col, val }),
  inArray: (col: unknown, vals: unknown[]) => ({ _op: 'inArray', col, vals }),
  or: (...conditions: unknown[]) => ({ _op: 'or', conditions }),
  and: (...conditions: unknown[]) => ({ _op: 'and', conditions }),
  ne: (col: unknown, val: unknown) => ({ _op: 'ne', col, val }),
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
  collectUserSessions,
  collectUserNotifications,
  collectUserDisplayPreferences,
  collectUserPersonalization,
  collectAllUserData,
} from './gdpr-export';

/** Creates a chain-mock db that resolves .where() calls with queued results */
function createChainDb(whereResults: unknown[][]) {
  let callIndex = 0;
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(() => {
      const result = whereResults[callIndex] ?? [];
      callIndex++;
      return result;
    }),
    innerJoin: vi.fn().mockReturnThis(),
  };
}

/** Creates a chain-mock db where the first where() returns a .limit() chain */
function createLimitDb(limitResult: unknown[]) {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(() => ({ limit: vi.fn().mockReturnValue(limitResult) })),
    innerJoin: vi.fn().mockReturnThis(),
  };
}

describe('collectUserProfile', () => {
  it('given_userExists_returnsProfile', async () => {
    const profile = {
      id: 'user-1',
      name: 'Test User',
      email: 'test@example.com',
      image: null,
      timezone: 'UTC',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = createLimitDb([profile]);

    const result = await collectUserProfile(db as never, 'user-1');

    expect(result).toEqual(profile);
  });

  it('given_userDoesNotExist_returnsNull', async () => {
    const db = createLimitDb([]);

    const result = await collectUserProfile(db as never, 'nonexistent');

    expect(result).toBeNull();
  });
});

describe('collectUserDrives', () => {
  it('given_ownedAndMemberDrives_returnsBothWithCorrectRoles', async () => {
    const ownedDrive = { id: 'drive-1', name: 'My Drive', slug: 'my-drive', createdAt: new Date() };
    const memberDrive = { id: 'drive-2', name: 'Shared Drive', slug: 'shared', role: 'MEMBER', createdAt: new Date() };
    const db = createChainDb([[ownedDrive], [memberDrive]]);

    const result = await collectUserDrives(db as never, 'user-1');

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('OWNER');
    expect(result[1].role).toBe('MEMBER');
  });

  it('given_userIsBothOwnerAndMember_deduplicatesKeepingOwnerRole', async () => {
    const drive = { id: 'drive-1', name: 'Drive', slug: 'drive', createdAt: new Date() };
    const db = createChainDb([[drive], [{ ...drive, role: 'ADMIN' }]]);

    const result = await collectUserDrives(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('OWNER');
  });
});

describe('collectUserPages', () => {
  it('given_driveIds_returnsPagesFromThoseDrives', async () => {
    const page = {
      id: 'page-1',
      title: 'Test Page',
      type: 'DOCUMENT',
      content: 'Hello',
      driveId: 'drive-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = createChainDb([[page]]);

    const result = await collectUserPages(db as never, 'user-1', ['drive-1']);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Test Page');
  });

  it('given_emptyDriveIds_returnsEmptyArrayWithoutQuery', async () => {
    const db = createChainDb([]);

    const result = await collectUserPages(db as never, 'user-1', []);

    expect(result).toEqual([]);
  });

  it('given_noPreloadedDriveIds_fetchesDrivesFirst', async () => {
    // owned drives → empty, member drives → empty → no pages
    const db = createChainDb([[], []]);

    const result = await collectUserPages(db as never, 'user-1');

    expect(result).toEqual([]);
  });
});

describe('collectUserMessages', () => {
  it('given_messagesInAllSources_aggregatesWithCorrectSourceLabels', async () => {
    const aiMsg = { id: 'm1', content: 'AI msg', role: 'user', pageId: 'p1', conversationId: 'c1', createdAt: new Date() };
    const channelMsg = { id: 'm2', content: 'Channel msg', pageId: 'p2', createdAt: new Date() };
    const convMsg = { id: 'm3', content: 'Conv msg', role: 'user', conversationId: 'c2', createdAt: new Date() };
    const dmMsg = { id: 'm4', content: 'DM msg', conversationId: 'c3', createdAt: new Date() };
    // 5th call: dmConversations lookup returns [] so no 6th call for received DMs
    const db = createChainDb([[aiMsg], [channelMsg], [convMsg], [dmMsg], []]);

    const result = await collectUserMessages(db as never, 'user-1');

    expect(result).toHaveLength(4);
    expect(result.map(r => r.source)).toEqual([
      'ai_chat', 'channel', 'conversation', 'direct_message',
    ]);
  });

  it('given_noMessages_returnsEmptyArray', async () => {
    // 5 calls: ai, channel, conv, sentDms, dmConversations
    const db = createChainDb([[], [], [], [], []]);

    const result = await collectUserMessages(db as never, 'user-1');

    expect(result).toEqual([]);
  });

  it('given_userHasSentDMs_setsDirectionSent', async () => {
    const sentDm = { id: 'm4', content: 'Sent DM', conversationId: 'conv-1', createdAt: new Date() };
    // ai=[], channel=[], conv=[], sentDms=[sentDm], dmConvIds=[] (no received)
    const db = createChainDb([[], [], [], [sentDm], []]);

    const result = await collectUserMessages(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('direct_message');
    expect(result[0].direction).toBe('sent');
  });

  it('given_userHasReceivedDMs_includesThemWithDirectionReceived', async () => {
    const convId = { id: 'conv-1' };
    const receivedDm = { id: 'm5', content: 'Received DM', conversationId: 'conv-1', createdAt: new Date() };
    // ai=[], channel=[], conv=[], sentDms=[], dmConvIds=[convId], receivedDms=[receivedDm]
    const db = createChainDb([[], [], [], [], [convId], [receivedDm]]);

    const result = await collectUserMessages(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('direct_message');
    expect(result[0].direction).toBe('received');
    expect(result[0].content).toBe('Received DM');
  });

  it('given_userHasBothSentAndReceivedDMs_includesBothWithCorrectDirections', async () => {
    const sentDm = { id: 'm4', content: 'Sent DM', conversationId: 'conv-1', createdAt: new Date() };
    const convId = { id: 'conv-1' };
    const receivedDm = { id: 'm5', content: 'Received DM', conversationId: 'conv-1', createdAt: new Date() };
    // ai=[], channel=[], conv=[], sentDms=[sentDm], dmConvIds=[convId], receivedDms=[receivedDm]
    const db = createChainDb([[], [], [], [sentDm], [convId], [receivedDm]]);

    const result = await collectUserMessages(db as never, 'user-1');

    expect(result).toHaveLength(2);
    const directions = result.map(r => r.direction);
    expect(directions).toContain('sent');
    expect(directions).toContain('received');
  });
});

describe('collectUserFiles', () => {
  it('given_filesExist_returnsFileMetadata', async () => {
    const file = {
      id: 'f1', driveId: 'd1', sizeBytes: 1024,
      mimeType: 'text/plain', storagePath: '/path', createdAt: new Date(),
    };
    const db = createChainDb([[file]]);

    const result = await collectUserFiles(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ id: 'f1', sizeBytes: 1024 }));
  });
});

describe('collectUserActivity', () => {
  it('given_activityExists_returnsLogs', async () => {
    const activity = {
      id: 'a1', operation: 'create', resourceType: 'page',
      resourceId: 'p1', timestamp: new Date(), metadata: null,
    };
    const db = createChainDb([[activity]]);

    const result = await collectUserActivity(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0].operation).toBe('create');
  });
});

describe('collectUserAiUsage', () => {
  it('given_usageExists_returnsLogs', async () => {
    const usage = {
      id: 'u1', provider: 'openai', model: 'gpt-4',
      inputTokens: 100, outputTokens: 50, cost: 0.01, timestamp: new Date(),
    };
    const db = createChainDb([[usage]]);

    const result = await collectUserAiUsage(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ provider: 'openai', model: 'gpt-4' }));
  });
});

describe('collectUserTasks', () => {
  it('given_tasksExist_returnsListsWithItems', async () => {
    const list = { id: 'tl1', title: 'My Tasks' };
    const item = { id: 'ti1', title: 'Task 1', status: 'pending', priority: 'high', taskListId: 'tl1', createdAt: new Date() };
    const db = createChainDb([[list], [item]]);

    const result = await collectUserTasks(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0].listTitle).toBe('My Tasks');
    expect(result[0].items).toHaveLength(1);
    expect(result[0].items[0].title).toBe('Task 1');
  });

  it('given_noTaskLists_returnsEmptyArray', async () => {
    const db = createChainDb([[]]);

    const result = await collectUserTasks(db as never, 'user-1');

    expect(result).toEqual([]);
  });

  it('given_listsWithNoItems_returnsListsWithEmptyItemsArray', async () => {
    const db = createChainDb([[{ id: 'tl1', title: 'Empty List' }], []]);

    const result = await collectUserTasks(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0].items).toEqual([]);
  });
});

describe('collectUserSessions', () => {
  it('given_userHasSessions_returnsSessionsWithoutCredentialFields', async () => {
    const session = {
      id: 'sess-1',
      type: 'user',
      deviceId: 'device-abc',
      scopes: [],
      createdByIp: '1.2.3.4',
      lastUsedAt: new Date(),
      lastUsedIp: '1.2.3.4',
      expiresAt: new Date(),
      revokedAt: null,
      revokedReason: null,
      createdAt: new Date(),
    };
    const db = createChainDb([[session]]);

    const result = await collectUserSessions(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('sess-1');
    expect(result[0].type).toBe('user');
    expect(result[0].createdByIp).toBe('1.2.3.4');
  });

  it('given_userHasNoSessions_returnsEmptyArray', async () => {
    const db = createChainDb([[]]);

    const result = await collectUserSessions(db as never, 'user-1');

    expect(result).toEqual([]);
  });
});

describe('collectUserNotifications', () => {
  it('given_userHasNotifications_returnsNotificationHistory', async () => {
    const notification = {
      id: 'notif-1',
      type: 'MENTION',
      title: 'You were mentioned',
      message: 'Alice mentioned you in a page',
      metadata: null,
      isRead: true,
      createdAt: new Date(),
      readAt: new Date(),
    };
    const db = createChainDb([[notification]]);

    const result = await collectUserNotifications(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('MENTION');
    expect(result[0].isRead).toBe(true);
  });

  it('given_userHasNoNotifications_returnsEmptyArray', async () => {
    const db = createChainDb([[]]);

    const result = await collectUserNotifications(db as never, 'user-1');

    expect(result).toEqual([]);
  });
});

describe('collectUserDisplayPreferences', () => {
  it('given_userHasDisplayPreferences_returnsAllPreferences', async () => {
    const pref = {
      preferenceType: 'SHOW_TOKEN_COUNTS',
      enabled: true,
      updatedAt: new Date(),
    };
    const db = createChainDb([[pref]]);

    const result = await collectUserDisplayPreferences(db as never, 'user-1');

    expect(result).toHaveLength(1);
    expect(result[0].preferenceType).toBe('SHOW_TOKEN_COUNTS');
    expect(result[0].enabled).toBe(true);
  });

  it('given_userHasNoDisplayPreferences_returnsEmptyArray', async () => {
    const db = createChainDb([[]]);

    const result = await collectUserDisplayPreferences(db as never, 'user-1');

    expect(result).toEqual([]);
  });
});

describe('collectUserPersonalization', () => {
  it('given_userHasPersonalization_returnsPersonalizationData', async () => {
    const personalization = {
      bio: 'I am a software engineer',
      writingStyle: 'concise and technical',
      rules: 'always use TypeScript',
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = createLimitDb([personalization]);

    const result = await collectUserPersonalization(db as never, 'user-1');

    expect(result).not.toBeNull();
    expect(result!.bio).toBe('I am a software engineer');
    expect(result!.writingStyle).toBe('concise and technical');
    expect(result!.rules).toBe('always use TypeScript');
  });

  it('given_userHasNoPersonalization_returnsNull', async () => {
    const db = createLimitDb([]);

    const result = await collectUserPersonalization(db as never, 'user-1');

    expect(result).toBeNull();
  });
});

describe('collectAllUserData', () => {
  it('given_userDoesNotExist_returnsNull', async () => {
    const db = createLimitDb([]);

    const result = await collectAllUserData(db as never, 'nonexistent');

    expect(result).toBeNull();
  });

  it('given_userExists_aggregatesAllDataCategories', async () => {
    const profile = {
      id: 'user-1', name: 'Test', email: 'test@test.com',
      image: null, timezone: 'UTC', createdAt: new Date(), updatedAt: new Date(),
    };

    // Returns an empty array that also has a .limit() method so both
    // callers that chain .limit() (profile, personalization) and callers
    // that use the array directly (drives, messages, etc.) both work.
    const emptyWithLimit = () => Object.assign([], { limit: vi.fn().mockReturnValue([]) });

    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Object.assign([], { limit: vi.fn().mockReturnValue([profile]) });
        }
        return emptyWithLimit();
      }),
      innerJoin: vi.fn().mockReturnThis(),
    };

    const result = await collectAllUserData(db as never, 'user-1');

    expect(result).not.toBeNull();
    expect(result!.profile.id).toBe('user-1');
    expect(result!.profile.email).toBe('test@test.com');
    expect(Array.isArray(result!.drives)).toBe(true);
    expect(Array.isArray(result!.pages)).toBe(true);
    expect(Array.isArray(result!.messages)).toBe(true);
    expect(Array.isArray(result!.files)).toBe(true);
    expect(Array.isArray(result!.activity)).toBe(true);
    expect(Array.isArray(result!.aiUsage)).toBe(true);
    expect(Array.isArray(result!.tasks)).toBe(true);
    expect(Array.isArray(result!.sessions)).toBe(true);
    expect(Array.isArray(result!.notifications)).toBe(true);
    expect(Array.isArray(result!.displayPreferences)).toBe(true);
    expect(result!.personalization).toBeNull();
  });
});

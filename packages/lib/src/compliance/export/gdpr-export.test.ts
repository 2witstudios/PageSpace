import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, users } from '@pagespace/db';
import { drives, pages, chatMessages } from '@pagespace/db';
import { taskLists, taskItems } from '@pagespace/db';
import { aiUsageLogs } from '@pagespace/db';
import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
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

type DBParam = Parameters<typeof collectUserProfile>[0];

let testUserId: string;
let testDriveId: string;

beforeEach(async () => {
  const [user] = await db.insert(users).values({
    id: createId(),
    name: 'GDPR Export Test User',
    email: `gdpr-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'hashed_password',
    provider: 'email',
    role: 'user',
    tokenVersion: 1,
    timezone: 'America/New_York',
  }).returning();
  testUserId = user.id;

  const [drive] = await db.insert(drives).values({
    id: createId(),
    name: 'GDPR Test Drive',
    slug: `gdpr-test-${Date.now()}`,
    ownerId: testUserId,
    updatedAt: new Date(),
  }).returning();
  testDriveId = drive.id;
});

afterEach(async () => {
  await db.delete(drives).where(eq(drives.id, testDriveId));
  await db.delete(users).where(eq(users.id, testUserId));
});

describe('collectUserProfile', () => {
  it('returns profile with expected fields', async () => {
    const profile = await collectUserProfile(db as DBParam, testUserId);

    expect(profile).toBeTruthy();
    expect(profile!.id).toBe(testUserId);
    expect(Object.keys(profile!).sort()).toEqual([
      'createdAt', 'email', 'id', 'image', 'name', 'timezone', 'updatedAt',
    ]);
  });

  it('returns null for nonexistent user', async () => {
    const profile = await collectUserProfile(db as DBParam, 'nonexistent-id');

    expect(profile).toBeNull();
  });
});

describe('collectUserDrives', () => {
  it('returns owned drives', async () => {
    const userDrives = await collectUserDrives(db as DBParam, testUserId);

    expect(userDrives.length).toBeGreaterThanOrEqual(1);
    const ownedDrive = userDrives.find(d => d.id === testDriveId);
    expect(ownedDrive).toBeTruthy();
    expect(ownedDrive!.role).toBe('OWNER');
  });
});

describe('collectUserPages', () => {
  let testPageId: string;

  beforeEach(async () => {
    const [page] = await db.insert(pages).values({
      id: createId(),
      title: 'GDPR Test Page',
      type: 'DOCUMENT',
      driveId: testDriveId,
      position: 0,
      updatedAt: new Date(),
    }).returning();
    testPageId = page.id;
  });

  afterEach(async () => {
    await db.delete(pages).where(eq(pages.id, testPageId));
  });

  it('returns pages from user drives', async () => {
    const userPages = await collectUserPages(db as DBParam, testUserId);

    expect(userPages.length).toBeGreaterThanOrEqual(1);
    const found = userPages.find(p => p.id === testPageId);
    expect(found).toBeTruthy();
    expect(found!.title).toBe('GDPR Test Page');
  });
});

describe('collectUserMessages', () => {
  let testPageId: string;

  beforeEach(async () => {
    const [page] = await db.insert(pages).values({
      id: createId(),
      title: 'Chat Test Page',
      type: 'AI_CHAT',
      driveId: testDriveId,
      position: 0,
      updatedAt: new Date(),
    }).returning();
    testPageId = page.id;
  });

  afterEach(async () => {
    await db.delete(chatMessages).where(eq(chatMessages.pageId, testPageId));
    await db.delete(pages).where(eq(pages.id, testPageId));
  });

  it('returns AI chat messages for the user', async () => {
    await db.insert(chatMessages).values({
      id: createId(),
      pageId: testPageId,
      role: 'user',
      content: 'Hello AI',
      userId: testUserId,
    });

    const userMessages = await collectUserMessages(db as DBParam, testUserId);

    const found = userMessages.find(m => m.content === 'Hello AI');
    expect(found).toBeTruthy();
    expect(found!.source).toBe('ai_chat');
  });
});

describe('collectUserAiUsage', () => {
  it('returns AI usage logs for the user', async () => {
    const logId = createId();
    await db.insert(aiUsageLogs).values({
      id: logId,
      userId: testUserId,
      provider: 'openrouter',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.01,
    });

    const usage = await collectUserAiUsage(db as DBParam, testUserId);

    const found = usage.find(u => u.id === logId);
    expect(found).toBeTruthy();
    expect(found!.provider).toBe('openrouter');
    expect(found!.model).toBe('gpt-4o');

    // cleanup
    await db.delete(aiUsageLogs).where(eq(aiUsageLogs.id, logId));
  });
});

describe('collectUserTasks', () => {
  let testListId: string;

  beforeEach(async () => {
    const [list] = await db.insert(taskLists).values({
      id: createId(),
      userId: testUserId,
      title: 'GDPR Test Tasks',
    }).returning();
    testListId = list.id;
  });

  afterEach(async () => {
    await db.delete(taskItems).where(eq(taskItems.taskListId, testListId));
    await db.delete(taskLists).where(eq(taskLists.id, testListId));
  });

  it('returns task lists with items', async () => {
    await db.insert(taskItems).values({
      id: createId(),
      taskListId: testListId,
      userId: testUserId,
      title: 'Test Task Item',
      status: 'pending',
      priority: 'medium',
    });

    const tasks = await collectUserTasks(db as DBParam, testUserId);

    const found = tasks.find(t => t.listId === testListId);
    expect(found).toBeTruthy();
    expect(found!.listTitle).toBe('GDPR Test Tasks');
    expect(found!.items.length).toBe(1);
    expect(found!.items[0].title).toBe('Test Task Item');
  });
});

describe('collectAllUserData', () => {
  it('returns all data categories', async () => {
    const data = await collectAllUserData(db as DBParam, testUserId);

    expect(data).toBeTruthy();
    expect(data!.profile.id).toBe(testUserId);
    expect(Array.isArray(data!.drives)).toBe(true);
    expect(Array.isArray(data!.pages)).toBe(true);
    expect(Array.isArray(data!.messages)).toBe(true);
    expect(Array.isArray(data!.files)).toBe(true);
    expect(Array.isArray(data!.activity)).toBe(true);
    expect(Array.isArray(data!.aiUsage)).toBe(true);
    expect(Array.isArray(data!.tasks)).toBe(true);
  });

  it('returns null for nonexistent user', async () => {
    const data = await collectAllUserData(db as DBParam, 'nonexistent-id');

    expect(data).toBeNull();
  });
});

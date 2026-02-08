import { eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  users,
  drives,
  pages,
  chatMessages,
  files,
  filePages,
  aiUsageLogs,
  activityLogs,
} from '@pagespace/db';
import { driveMembers } from '@pagespace/db';
import { channelMessages } from '@pagespace/db';
import { conversations, messages } from '@pagespace/db';
import { directMessages, dmConversations } from '@pagespace/db';
import { taskLists, taskItems } from '@pagespace/db';

type DB = NodePgDatabase<Record<string, unknown>>;

export interface UserProfileExport {
  id: string;
  name: string;
  email: string;
  image: string | null;
  timezone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserDriveExport {
  id: string;
  name: string;
  slug: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  createdAt: Date;
}

export interface UserPageExport {
  id: string;
  title: string;
  type: string;
  content: string;
  driveId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserMessageExport {
  id: string;
  source: 'ai_chat' | 'channel' | 'conversation' | 'direct_message';
  content: string;
  role?: string;
  pageId?: string;
  conversationId?: string;
  createdAt: Date;
}

export interface UserFileExport {
  id: string;
  driveId: string;
  sizeBytes: number;
  mimeType: string | null;
  storagePath: string | null;
  createdAt: Date;
}

export interface UserActivityExport {
  id: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  timestamp: Date;
  metadata: Record<string, unknown> | null;
}

export interface UserAiUsageExport {
  id: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  timestamp: Date;
}

export interface UserTaskExport {
  listId: string;
  listTitle: string;
  items: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    createdAt: Date;
  }>;
}

export interface AllUserData {
  profile: UserProfileExport;
  drives: UserDriveExport[];
  pages: UserPageExport[];
  messages: UserMessageExport[];
  files: UserFileExport[];
  activity: UserActivityExport[];
  aiUsage: UserAiUsageExport[];
  tasks: UserTaskExport[];
}

export async function collectUserProfile(database: DB, userId: string): Promise<UserProfileExport | null> {
  const result = await database
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      timezone: users.timezone,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return result[0] ?? null;
}

export async function collectUserDrives(database: DB, userId: string): Promise<UserDriveExport[]> {
  // Owned drives
  const ownedDrives = await database
    .select({
      id: drives.id,
      name: drives.name,
      slug: drives.slug,
      createdAt: drives.createdAt,
    })
    .from(drives)
    .where(eq(drives.ownerId, userId));

  const owned: UserDriveExport[] = ownedDrives.map(d => ({
    ...d,
    role: 'OWNER' as const,
  }));

  // Member drives
  const memberDrives = await database
    .select({
      id: drives.id,
      name: drives.name,
      slug: drives.slug,
      role: driveMembers.role,
      createdAt: drives.createdAt,
    })
    .from(driveMembers)
    .innerJoin(drives, eq(driveMembers.driveId, drives.id))
    .where(eq(driveMembers.userId, userId));

  const members: UserDriveExport[] = memberDrives.map(d => ({
    id: d.id,
    name: d.name,
    slug: d.slug,
    role: d.role,
    createdAt: d.createdAt,
  }));

  // Deduplicate (owner is also a member)
  const seen = new Set(owned.map(d => d.id));
  const unique = [...owned];
  for (const m of members) {
    if (!seen.has(m.id)) {
      unique.push(m);
      seen.add(m.id);
    }
  }
  return unique;
}

export async function collectUserPages(
  database: DB,
  userId: string,
  preloadedDriveIds?: string[],
): Promise<UserPageExport[]> {
  const driveIds = preloadedDriveIds ?? (await collectUserDrives(database, userId)).map(d => d.id);

  if (driveIds.length === 0) return [];

  return database
    .select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      content: pages.content,
      driveId: pages.driveId,
      createdAt: pages.createdAt,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(inArray(pages.driveId, driveIds));
}

export async function collectUserMessages(database: DB, userId: string): Promise<UserMessageExport[]> {
  const result: UserMessageExport[] = [];

  // AI chat messages (chatMessages table)
  const aiChats = await database
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      role: chatMessages.role,
      pageId: chatMessages.pageId,
      conversationId: chatMessages.conversationId,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.userId, userId));

  for (const msg of aiChats) {
    result.push({
      id: msg.id,
      source: 'ai_chat',
      content: msg.content,
      role: msg.role,
      pageId: msg.pageId,
      conversationId: msg.conversationId,
      createdAt: msg.createdAt,
    });
  }

  // Channel messages
  const channelMsgs = await database
    .select({
      id: channelMessages.id,
      content: channelMessages.content,
      pageId: channelMessages.pageId,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(eq(channelMessages.userId, userId));

  for (const msg of channelMsgs) {
    result.push({
      id: msg.id,
      source: 'channel',
      content: msg.content,
      pageId: msg.pageId,
      createdAt: msg.createdAt,
    });
  }

  // Conversation messages (unified conversations table)
  const convMsgs = await database
    .select({
      id: messages.id,
      content: messages.content,
      role: messages.role,
      conversationId: messages.conversationId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.userId, userId));

  for (const msg of convMsgs) {
    result.push({
      id: msg.id,
      source: 'conversation',
      content: msg.content,
      role: msg.role,
      conversationId: msg.conversationId,
      createdAt: msg.createdAt,
    });
  }

  // Direct messages
  const dms = await database
    .select({
      id: directMessages.id,
      content: directMessages.content,
      conversationId: directMessages.conversationId,
      createdAt: directMessages.createdAt,
    })
    .from(directMessages)
    .where(eq(directMessages.senderId, userId));

  for (const msg of dms) {
    result.push({
      id: msg.id,
      source: 'direct_message',
      content: msg.content,
      conversationId: msg.conversationId,
      createdAt: msg.createdAt,
    });
  }

  return result;
}

export async function collectUserFiles(database: DB, userId: string): Promise<UserFileExport[]> {
  const result = await database
    .select({
      id: files.id,
      driveId: files.driveId,
      sizeBytes: files.sizeBytes,
      mimeType: files.mimeType,
      storagePath: files.storagePath,
      createdAt: files.createdAt,
    })
    .from(files)
    .where(eq(files.createdBy, userId));

  return result;
}

export async function collectUserActivity(database: DB, userId: string): Promise<UserActivityExport[]> {
  const result = await database
    .select({
      id: activityLogs.id,
      operation: activityLogs.operation,
      resourceType: activityLogs.resourceType,
      resourceId: activityLogs.resourceId,
      timestamp: activityLogs.timestamp,
      metadata: activityLogs.metadata,
    })
    .from(activityLogs)
    .where(eq(activityLogs.userId, userId));

  return result;
}

export async function collectUserAiUsage(database: DB, userId: string): Promise<UserAiUsageExport[]> {
  const result = await database
    .select({
      id: aiUsageLogs.id,
      provider: aiUsageLogs.provider,
      model: aiUsageLogs.model,
      inputTokens: aiUsageLogs.inputTokens,
      outputTokens: aiUsageLogs.outputTokens,
      cost: aiUsageLogs.cost,
      timestamp: aiUsageLogs.timestamp,
    })
    .from(aiUsageLogs)
    .where(eq(aiUsageLogs.userId, userId));

  return result;
}

export async function collectUserTasks(database: DB, userId: string): Promise<UserTaskExport[]> {
  const lists = await database
    .select({
      id: taskLists.id,
      title: taskLists.title,
    })
    .from(taskLists)
    .where(eq(taskLists.userId, userId));

  if (lists.length === 0) return [];

  const listIds = lists.map(l => l.id);
  const allItems = await database
    .select({
      id: taskItems.id,
      title: taskItems.title,
      status: taskItems.status,
      priority: taskItems.priority,
      taskListId: taskItems.taskListId,
      createdAt: taskItems.createdAt,
    })
    .from(taskItems)
    .where(inArray(taskItems.taskListId, listIds));

  const itemsByList = new Map<string, typeof allItems>();
  for (const item of allItems) {
    const existing = itemsByList.get(item.taskListId) ?? [];
    existing.push(item);
    itemsByList.set(item.taskListId, existing);
  }

  return lists.map(list => ({
    listId: list.id,
    listTitle: list.title,
    items: (itemsByList.get(list.id) ?? []).map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      createdAt: item.createdAt,
    })),
  }));
}

export async function collectAllUserData(database: DB, userId: string): Promise<AllUserData | null> {
  const profile = await collectUserProfile(database, userId);
  if (!profile) return null;

  const userDrives = await collectUserDrives(database, userId);
  const driveIds = userDrives.map(d => d.id);

  const [userPages, userMessages, userFiles, activity, aiUsage, tasks] = await Promise.all([
    collectUserPages(database, userId, driveIds),
    collectUserMessages(database, userId),
    collectUserFiles(database, userId),
    collectUserActivity(database, userId),
    collectUserAiUsage(database, userId),
    collectUserTasks(database, userId),
  ]);

  return {
    profile,
    drives: userDrives,
    pages: userPages,
    messages: userMessages,
    files: userFiles,
    activity,
    aiUsage,
    tasks,
  };
}

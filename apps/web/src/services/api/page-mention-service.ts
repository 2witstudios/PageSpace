import * as cheerio from 'cheerio';
import { db, mentions, userMentions, eq, and, inArray } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseType = typeof db;

interface MentionIds {
  pageIds: string[];
  userIds: string[];
}

function findMentionNodes(content: unknown): MentionIds {
  const pageIds: string[] = [];
  const userIds: string[] = [];
  const contentStr = Array.isArray(content) ? content.join('\n') : String(content);

  const shouldParseHtml = contentStr.includes('<') && contentStr.includes('data-page-id');

  let parseFailed = false;
  if (shouldParseHtml) {
    try {
      const $ = cheerio.load(contentStr);
      // Parse page mentions from HTML
      $('a[data-page-id]').each((_, element) => {
        const pageId = $(element).attr('data-page-id');
        if (pageId) {
          pageIds.push(pageId);
        }
      });
      // Parse user mentions from HTML
      $('a[data-user-id]').each((_, element) => {
        const userId = $(element).attr('data-user-id');
        if (userId) {
          userIds.push(userId);
        }
      });
    } catch (error) {
      loggers.api.error('Error parsing HTML content for mentions:', error as Error);
      parseFailed = true;
    }
  }

  if (!shouldParseHtml || parseFailed) {
    // Parse markdown-style mentions: @[Label](id:type)
    const regex = /@\[([^\]]*)\]\(([^:)]+):?([^)]*)\)/g;
    let match;
    while ((match = regex.exec(contentStr)) !== null) {
      const id = match[2];
      const type = match[3] || 'page'; // Default to page if no type specified
      if (type === 'user') {
        userIds.push(id);
      } else {
        pageIds.push(id);
      }
    }
  }

  return {
    pageIds: Array.from(new Set(pageIds)),
    userIds: Array.from(new Set(userIds)),
  };
}

export interface SyncMentionsOptions {
  mentionedByUserId?: string;
}

export interface SyncMentionsResult {
  newlyMentionedUserIds: string[];
  sourcePageId: string;
  mentionedByUserId?: string;
}

export async function syncMentions(
  sourcePageId: string,
  content: unknown,
  tx: TransactionType | DatabaseType,
  options?: SyncMentionsOptions
): Promise<SyncMentionsResult> {
  const { pageIds: mentionedPageIds, userIds: mentionedUserIds } = findMentionNodes(content);

  // Sync page mentions
  await syncPageMentions(sourcePageId, mentionedPageIds, tx);

  // Sync user mentions and get newly created user IDs
  const newlyMentionedUserIds = await syncUserMentions(sourcePageId, mentionedUserIds, tx, options?.mentionedByUserId);

  return {
    newlyMentionedUserIds,
    sourcePageId,
    mentionedByUserId: options?.mentionedByUserId,
  };
}

async function syncPageMentions(
  sourcePageId: string,
  mentionedPageIds: string[],
  tx: TransactionType | DatabaseType
): Promise<void> {
  const mentionedPageIdSet = new Set(mentionedPageIds);

  const existingMentionsQuery = await tx
    .select({ targetPageId: mentions.targetPageId })
    .from(mentions)
    .where(eq(mentions.sourcePageId, sourcePageId));
  const existingMentionIds = new Set(existingMentionsQuery.map(m => m.targetPageId));

  const toCreate = mentionedPageIds.filter(id => !existingMentionIds.has(id));
  const toDelete = Array.from(existingMentionIds).filter(id => !mentionedPageIdSet.has(id));

  if (toCreate.length > 0) {
    await tx.insert(mentions).values(toCreate.map(targetPageId => ({
      sourcePageId,
      targetPageId,
    })));
  }

  if (toDelete.length > 0) {
    await tx.delete(mentions).where(and(
      eq(mentions.sourcePageId, sourcePageId),
      inArray(mentions.targetPageId, toDelete)
    ));
  }
}

async function syncUserMentions(
  sourcePageId: string,
  mentionedUserIds: string[],
  tx: TransactionType | DatabaseType,
  mentionedByUserId?: string
): Promise<string[]> {
  const mentionedUserIdSet = new Set(mentionedUserIds);

  const existingMentionsQuery = await tx
    .select({ targetUserId: userMentions.targetUserId })
    .from(userMentions)
    .where(eq(userMentions.sourcePageId, sourcePageId));
  const existingMentionUserIds = new Set(existingMentionsQuery.map(m => m.targetUserId));

  const toCreate = mentionedUserIds.filter(id => !existingMentionUserIds.has(id));
  const toDelete = Array.from(existingMentionUserIds).filter(id => !mentionedUserIdSet.has(id));

  if (toCreate.length > 0) {
    await tx.insert(userMentions).values(toCreate.map(targetUserId => ({
      sourcePageId,
      targetUserId,
      mentionedByUserId: mentionedByUserId || null,
    })));
  }

  if (toDelete.length > 0) {
    await tx.delete(userMentions).where(and(
      eq(userMentions.sourcePageId, sourcePageId),
      inArray(userMentions.targetUserId, toDelete)
    ));
  }

  // Return newly created user IDs so caller can send notifications after transaction commits
  return toCreate;
}

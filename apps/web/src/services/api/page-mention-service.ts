import * as cheerio from 'cheerio';
import { db } from '@pagespace/db/db'
import { eq, and, inArray } from '@pagespace/db/operators'
import { mentions, userMentions } from '@pagespace/db/schema/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  getDriveRecipientUserIds,
  getDriveMemberUserIdsByStandardRole,
  getDriveMemberUserIdsByCustomRole,
} from '@pagespace/lib/services/drive-member-service';

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseType = typeof db;

interface GroupMention {
  type: 'everyone' | 'role';
  roleId?: string;
  driveId?: string;
}

interface MentionIds {
  pageIds: string[];
  userIds: string[];
  groupMentions: GroupMention[];
}

const STANDARD_ROLES = new Set(['OWNER', 'ADMIN', 'MEMBER']);

function findMentionNodes(content: unknown): MentionIds {
  const pageIds: string[] = [];
  const userIds: string[] = [];
  const groupMentions: GroupMention[] = [];
  const seenGroups = new Set<string>();
  const contentStr = Array.isArray(content) ? content.join('\n') : String(content);

  const shouldParseHtml = contentStr.includes('<') && (
    contentStr.includes('data-page-id') ||
    contentStr.includes('data-mention-type="everyone"') ||
    contentStr.includes('data-mention-type="role"')
  );

  let parseFailed = false;
  if (shouldParseHtml) {
    try {
      const $ = cheerio.load(contentStr);
      $('a[data-page-id]').each((_, element) => {
        const pageId = $(element).attr('data-page-id');
        if (pageId) pageIds.push(pageId);
      });
      $('a[data-user-id]').each((_, element) => {
        const userId = $(element).attr('data-user-id');
        if (userId) userIds.push(userId);
      });
      $('span[data-mention-type="everyone"]').each((_, element) => {
        const key = 'everyone';
        if (!seenGroups.has(key)) {
          seenGroups.add(key);
          groupMentions.push({
            type: 'everyone',
            driveId: $(element).attr('data-drive-id'),
          });
        }
      });
      $('span[data-mention-type="role"]').each((_, element) => {
        const roleId = $(element).attr('data-role-id');
        if (!roleId) return;
        const key = `role:${roleId}`;
        if (!seenGroups.has(key)) {
          seenGroups.add(key);
          groupMentions.push({
            type: 'role',
            roleId,
            driveId: $(element).attr('data-drive-id'),
          });
        }
      });
    } catch (error) {
      loggers.api.error('Error parsing HTML content for mentions:', error as Error);
      parseFailed = true;
    }
  }

  if (!shouldParseHtml || parseFailed) {
    // Parse markdown-style mentions: @[Label](id:type)
    const regex = /@\[([^\]]{1,500})\]\(([^:)]{1,200}):?([^)]{0,200})\)/g;
    let match;
    while ((match = regex.exec(contentStr)) !== null) {
      const id = match[2];
      const type = match[3] || 'page';
      if (type === 'user') {
        userIds.push(id);
      } else if (type === 'everyone') {
        const key = 'everyone';
        if (!seenGroups.has(key)) {
          seenGroups.add(key);
          groupMentions.push({ type: 'everyone' });
        }
      } else if (type === 'role') {
        const key = `role:${id}`;
        if (!seenGroups.has(key)) {
          seenGroups.add(key);
          groupMentions.push({ type: 'role', roleId: id });
        }
      } else {
        pageIds.push(id);
      }
    }
  }

  return {
    pageIds: Array.from(new Set(pageIds)),
    userIds: Array.from(new Set(userIds)),
    groupMentions,
  };
}

async function expandGroupMentions(
  groupMentions: GroupMention[],
  driveId: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];

  const addIds = (ids: string[]) => {
    for (const id of ids) {
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
  };

  for (const gm of groupMentions) {
    if (gm.type === 'everyone') {
      addIds(await getDriveRecipientUserIds(driveId));
    } else if (gm.type === 'role' && gm.roleId) {
      const ids = STANDARD_ROLES.has(gm.roleId)
        ? await getDriveMemberUserIdsByStandardRole(driveId, gm.roleId as 'OWNER' | 'ADMIN' | 'MEMBER')
        : await getDriveMemberUserIdsByCustomRole(driveId, gm.roleId);
      addIds(ids);
    }
  }

  return out;
}

export interface SyncMentionsOptions {
  mentionedByUserId?: string;
  driveId?: string;
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
  const { pageIds: mentionedPageIds, userIds: directUserIds, groupMentions } = findMentionNodes(content);

  // Expand group mentions (@everyone, @role) to individual user IDs
  let expandedUserIds: string[] = [];
  if (groupMentions.length > 0 && options?.driveId) {
    expandedUserIds = await expandGroupMentions(groupMentions, options.driveId);
  }

  // Merge direct and group-expanded user IDs, preserving uniqueness
  const allUserIdSet = new Set([...directUserIds, ...expandedUserIds]);
  const mentionedUserIds = Array.from(allUserIdSet);

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

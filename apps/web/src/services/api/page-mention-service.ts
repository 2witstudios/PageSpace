import * as cheerio from 'cheerio';
import { db } from '@pagespace/db/db'
import { eq, and, inArray } from '@pagespace/db/operators'
import { mentions, userMentions, pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
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

/**
 * Remove <pre> and <code> regions so documentation that shows literal mention
 * syntax (e.g. a doc explaining `@[Label](id:type)`) is never parsed as a real
 * mention. Without this, the placeholder "id" reaches the mentions insert and
 * fails the FK, aborting the caller's whole save transaction.
 */
function stripCodeRegions(content: string): string {
  return content
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi, ' ')
    .replace(/<code\b[^>]*>[\s\S]*?<\/code\s*>/gi, ' ');
}

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
      // Code regions hold literal examples, not real mentions.
      $('pre, code').remove();
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
    const searchable = stripCodeRegions(contentStr);
    const regex = /@\[([^\]]{1,500})\]\(([^:)]{1,200}):?([^)]{0,200})\)/g;
    let match;
    while ((match = regex.exec(searchable)) !== null) {
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

/**
 * Filter extracted page IDs down to pages that actually exist. Mention IDs
 * come from user-authored content (and can be literal format examples like
 * `@[Label](id:type)`), so an unvalidated insert can violate the
 * mentions_targetPageId FK and abort the caller's save transaction.
 * Nonexistent IDs are dropped silently — a bad mention must never fail a save.
 */
async function filterToExistingPageIds(
  pageIds: string[],
  tx: TransactionType | DatabaseType
): Promise<string[]> {
  if (pageIds.length === 0) return [];
  const rows = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(inArray(pages.id, pageIds));
  const existing = new Set(rows.map(r => r.id));
  return pageIds.filter(id => existing.has(id));
}

/** Same FK hazard as page IDs: userMentions.targetUserId references users.id. */
async function filterToExistingUserIds(
  userIds: string[],
  tx: TransactionType | DatabaseType
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, userIds));
  const existing = new Set(rows.map(r => r.id));
  return userIds.filter(id => existing.has(id));
}

export async function syncMentions(
  sourcePageId: string,
  content: unknown,
  tx: TransactionType | DatabaseType,
  options?: SyncMentionsOptions
): Promise<SyncMentionsResult> {
  const emptyResult: SyncMentionsResult = {
    newlyMentionedUserIds: [],
    sourcePageId,
    mentionedByUserId: options?.mentionedByUserId,
  };

  // Mention sync runs inside the caller's save transaction, so a throw here on
  // bad content poisons the whole save. Content parsing failures skip the sync
  // (existing mention rows are left untouched) rather than failing the save.
  let extracted: MentionIds;
  try {
    extracted = findMentionNodes(content);
  } catch (error) {
    loggers.api.error('Failed to parse content for mentions; skipping mention sync:', error as Error);
    return emptyResult;
  }
  const { pageIds: extractedPageIds, userIds: directUserIds, groupMentions } = extracted;

  // Expand group mentions (@everyone, @role) to individual user IDs. Role IDs
  // also come from content, so expansion is fail-soft: on error the group
  // mention is dropped and the save proceeds.
  let expandedUserIds: string[] = [];
  if (groupMentions.length > 0 && options?.driveId) {
    try {
      expandedUserIds = await expandGroupMentions(groupMentions, options.driveId);
    } catch (error) {
      loggers.api.error('Failed to expand group mentions; dropping group recipients:', error as Error);
    }
  }

  // Merge direct and group-expanded user IDs, preserving uniqueness
  const allUserIdSet = new Set([...directUserIds, ...expandedUserIds]);

  // Validate every extracted ID against the database before any insert —
  // nonexistent targets (literal examples, deleted pages, stale users) are
  // dropped silently instead of violating an FK mid-transaction.
  const mentionedPageIds = await filterToExistingPageIds(extractedPageIds, tx);
  const mentionedUserIds = await filterToExistingUserIds(Array.from(allUserIdSet), tx);

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

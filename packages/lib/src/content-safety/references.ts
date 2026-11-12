/**
 * Everything that points at a content hash — pages, file rows, messages,
 * drives and the people who put it there. Read-only: a takedown records these
 * on the case and leaves the rows as they are (readers answer "removed" from
 * the blocklist instead).
 *
 * IDs only. No titles, filenames or message text ever leave this module.
 */

import { db } from '@pagespace/db/db';
import { eq, inArray, like, or, sql } from '@pagespace/db/operators';
import { channelMessageAttachments, channelMessages } from '@pagespace/db/schema/chat';
import { messages } from '@pagespace/db/schema/conversations';
import { pages } from '@pagespace/db/schema/core';
import { directMessageAttachments, directMessages } from '@pagespace/db/schema/social';
import { fileConversations, filePages, files } from '@pagespace/db/schema/storage';
import { escapeLikePattern } from '../db/like-pattern';
import { loggers } from '../logging/logger-config';
import { normalizeContentHash } from './policy';
import type { ContentReferences } from './takedown';

/** Per-list cap. A hash referenced more widely than this is recorded as truncated. */
export const REFERENCE_LIMIT = 1000;

/** Both forms a stored reference to the hash can take (see `toContentHash` in the web app). */
export function storedFormsOf(contentHash: string): string[] {
  return [contentHash, `files/${contentHash}/original`];
}

export async function collectContentReferences(rawHash: string): Promise<ContentReferences> {
  const contentHash = normalizeContentHash(rawHash);
  if (!contentHash) throw new Error('Invalid content hash');
  const forms = storedFormsOf(contentHash);
  let truncated = false;
  const capped = <T>(rows: T[]): T[] => {
    if (rows.length > REFERENCE_LIMIT) {
      truncated = true;
      return rows.slice(0, REFERENCE_LIMIT);
    }
    return rows;
  };
  const fetchLimit = REFERENCE_LIMIT + 1;

  const pageIds = new Set<string>();
  const driveIds = new Set<string>();
  const uploaders = new Set<string>();
  const conversationIds = new Set<string>();

  const pageRows = capped(
    await db
      .select({ id: pages.id, driveId: pages.driveId, createdBy: pages.createdBy })
      .from(pages)
      .where(or(inArray(pages.filePath, forms), eq(pages.contentHash, contentHash)))
      .limit(fetchLimit),
  );
  for (const row of pageRows) {
    pageIds.add(row.id);
    driveIds.add(row.driveId);
    if (row.createdBy) uploaders.add(row.createdBy);
  }

  const fileRows = capped(
    await db
      .select({ id: files.id, driveId: files.driveId, createdBy: files.createdBy })
      .from(files)
      .where(or(eq(files.id, contentHash), inArray(files.storagePath, forms)))
      .limit(fetchLimit),
  );
  const fileIds = fileRows.map((row) => row.id);
  for (const row of fileRows) {
    if (row.driveId) driveIds.add(row.driveId);
    if (row.createdBy) uploaders.add(row.createdBy);
  }

  const channelMessageIds = new Set<string>();
  const directMessageIds = new Set<string>();

  if (fileIds.length > 0) {
    const linkedPages = capped(
      await db
        .select({ pageId: filePages.pageId })
        .from(filePages)
        .where(inArray(filePages.fileId, fileIds))
        .limit(fetchLimit),
    );
    // A link attaches a file that is already stored. The linker is recorded
    // through the page, not as an uploader: `uploaderUserIds` drives the
    // optional suspension, and it names only who brought the bytes in.
    for (const row of linkedPages) pageIds.add(row.pageId);

    const linkedConversations = capped(
      await db
        .select({ conversationId: fileConversations.conversationId })
        .from(fileConversations)
        .where(inArray(fileConversations.fileId, fileIds))
        .limit(fetchLimit),
    );
    for (const row of linkedConversations) conversationIds.add(row.conversationId);

    for (const row of capped(
      await db.select({ id: channelMessages.id }).from(channelMessages).where(inArray(channelMessages.fileId, fileIds)).limit(fetchLimit),
    )) channelMessageIds.add(row.id);
    for (const row of capped(
      await db
        .select({ id: channelMessageAttachments.messageId })
        .from(channelMessageAttachments)
        .where(inArray(channelMessageAttachments.fileId, fileIds))
        .limit(fetchLimit),
    )) channelMessageIds.add(row.id);

    for (const row of capped(
      await db
        .select({ id: directMessages.id, conversationId: directMessages.conversationId })
        .from(directMessages)
        .where(inArray(directMessages.fileId, fileIds))
        .limit(fetchLimit),
    )) {
      directMessageIds.add(row.id);
      conversationIds.add(row.conversationId);
    }
    for (const row of capped(
      await db
        .select({ id: directMessageAttachments.messageId })
        .from(directMessageAttachments)
        .where(inArray(directMessageAttachments.fileId, fileIds))
        .limit(fetchLimit),
    )) directMessageIds.add(row.id);
  }

  // AI chat attachments have no `files` row: the message body carries the
  // storage key, and finding it is an unindexed scan that can exceed the
  // statement timeout on a large table. Here it is a quick, best-effort attempt
  // at the pool's ordinary timeout: whatever it finds is kept, and a failure is
  // flagged, never passed off as "none". A takedown ALSO runs the scan as a
  // mandatory, retried step with a longer timeout (`collectAiMessageReferences`
  // with `extendedTimeout`), so nothing depends on this attempt succeeding.
  let ai: AiMessageReferences = { aiMessageIds: [], conversationIds: [], uploaderUserIds: [], truncated: false };
  let aiMessageScanFailed = false;
  try {
    ai = await collectAiMessageReferences(contentHash);
  } catch {
    aiMessageScanFailed = true;
  }
  for (const id of ai.conversationIds) conversationIds.add(id);
  for (const id of ai.uploaderUserIds) uploaders.add(id);

  return {
    pageIds: [...pageIds],
    fileIds,
    driveIds: [...driveIds],
    uploaderUserIds: [...uploaders],
    channelMessageIds: [...channelMessageIds],
    directMessageIds: [...directMessageIds],
    aiMessageIds: ai.aiMessageIds,
    conversationIds: [...conversationIds],
    truncated: truncated || ai.truncated,
    ...(aiMessageScanFailed ? { aiMessageScanFailed: true } : {}),
  };
}

export interface AiMessageReferences {
  aiMessageIds: string[];
  conversationIds: string[];
  /** Authors of the messages that carry the attachment: for a chat attachment, they are the uploaders. */
  uploaderUserIds: string[];
  truncated: boolean;
}

/** Statement timeout for the mandatory message scan. The pool default (15s) is too short for a large table. */
const EXTENDED_AI_SCAN_TIMEOUT = '120s';

/**
 * AI chat messages whose body carries this hash's attachment key, and their
 * authors. Throws when the scan cannot finish — it never returns an incomplete
 * list as if it were whole, because for content uploaded only through AI chat
 * this is the ONLY record of who uploaded it.
 *
 * `extendedTimeout` runs the scan in its own transaction with a longer
 * statement timeout, so it applies to this one statement and nothing else on
 * the connection. Without it the scan runs at the pool's ordinary timeout.
 */
export async function collectAiMessageReferences(
  rawHash: string,
  options: { extendedTimeout?: boolean } = {},
): Promise<AiMessageReferences> {
  const contentHash = normalizeContentHash(rawHash);
  if (!contentHash) throw new Error('Invalid content hash');
  const pattern = `%${escapeLikePattern(`chat-attachments/${contentHash}/original`)}%`;
  type Executor = Pick<typeof db, 'select'>;
  const scan = (executor: Executor) =>
    executor
      .select({ id: messages.id, conversationId: messages.conversationId, userId: messages.userId })
      .from(messages)
      .where(like(messages.content, pattern))
      .limit(REFERENCE_LIMIT + 1);

  let rows: Array<{ id: string; conversationId: string; userId: string | null }>;
  try {
    rows = options.extendedTimeout
      ? await db.transaction(async (tx) => {
          await tx.execute(sql.raw(`set local statement_timeout = '${EXTENDED_AI_SCAN_TIMEOUT}'`));
          return scan(tx);
        })
      : await scan(db);
  } catch (error) {
    // No hash in the log line.
    loggers.security.error('Content references: AI message search failed', error instanceof Error ? error : undefined);
    throw error;
  }

  const truncated = rows.length > REFERENCE_LIMIT;
  const kept = truncated ? rows.slice(0, REFERENCE_LIMIT) : rows;
  return {
    aiMessageIds: kept.map((row) => row.id),
    conversationIds: [...new Set(kept.map((row) => row.conversationId))],
    uploaderUserIds: [...new Set(kept.flatMap((row) => row.userId ?? []))],
    truncated,
  };
}

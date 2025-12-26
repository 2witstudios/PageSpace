import * as cheerio from 'cheerio';
import { db, mentions, eq, and, inArray } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseType = typeof db;

function findMentionNodes(content: unknown): string[] {
  const ids: string[] = [];
  const contentStr = Array.isArray(content) ? content.join('\n') : String(content);

  const shouldParseHtml = contentStr.includes('<') && contentStr.includes('data-page-id');

  let parseFailed = false;
  if (shouldParseHtml) {
    try {
      const $ = cheerio.load(contentStr);
      $('a[data-page-id]').each((_, element) => {
        const pageId = $(element).attr('data-page-id');
        if (pageId) {
          ids.push(pageId);
        }
      });
    } catch (error) {
      loggers.api.error('Error parsing HTML content for mentions:', error as Error);
      parseFailed = true;
    }
  }

  if (!shouldParseHtml || parseFailed) {
    const regex = /@\[.*?\]\((.*?)\)/g;
    let match;
    while ((match = regex.exec(contentStr)) !== null) {
      ids.push(match[1]);
    }
  }

  return Array.from(new Set(ids));
}

export async function syncMentions(
  sourcePageId: string,
  content: unknown,
  tx: TransactionType | DatabaseType
): Promise<void> {
  const mentionedPageIds = findMentionNodes(content);
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

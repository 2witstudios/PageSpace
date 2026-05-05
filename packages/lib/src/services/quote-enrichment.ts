/**
 * Read-time enrichment for inline quote replies.
 *
 * Given a batch of channel or DM message rows that may carry `quotedMessageId`,
 * issues a single `WHERE id IN (...)` lookup against the matching message table
 * and shape-merges a denormalized `quotedMessage` snapshot onto each row.
 *
 * Soft-deleted source messages are intentionally NOT filtered out by the query
 * — the renderer reads `isActive` to decide whether to show a tombstone, and
 * silently dropping the row would make the embed disappear instead.
 */

import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { channelMessages } from '@pagespace/db/schema/chat';
import { directMessages } from '@pagespace/db/schema/social';
import { buildThreadPreview } from './preview';

export type QuoteScope = 'channel' | 'dm';

export interface QuotedMessageSnapshot {
  id: string;
  authorId: string | null;
  authorName: string | null;
  authorImage: string | null;
  contentSnippet: string;
  createdAt: Date;
  isActive: boolean;
}

interface QuoteSourceRow {
  id: string;
  content: string;
  createdAt: Date;
  isActive: boolean;
  user?: { id: string; name: string | null; image: string | null } | null;
  sender?: { id: string; name: string | null; image: string | null } | null;
}

const userColumns = { id: true, name: true, image: true } as const;

function snapshotFromRow(row: QuoteSourceRow): QuotedMessageSnapshot {
  const author = row.user ?? row.sender ?? null;
  return {
    id: row.id,
    authorId: author?.id ?? null,
    authorName: author?.name ?? null,
    authorImage: author?.image ?? null,
    contentSnippet: buildThreadPreview(row.content),
    createdAt: row.createdAt,
    isActive: row.isActive,
  };
}

export async function attachQuotedMessages<T extends { quotedMessageId: string | null }>(
  rows: T[],
  scope: QuoteScope,
): Promise<(T & { quotedMessage: QuotedMessageSnapshot | null })[]> {
  const ids = Array.from(
    new Set(
      rows
        .map((r) => r.quotedMessageId)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  );

  if (ids.length === 0) {
    return rows.map((row) => ({ ...row, quotedMessage: null }));
  }

  const records: QuoteSourceRow[] =
    scope === 'channel'
      ? await db.query.channelMessages.findMany({
          where: inArray(channelMessages.id, ids),
          with: { user: { columns: userColumns } },
        })
      : await db.query.directMessages.findMany({
          where: inArray(directMessages.id, ids),
          with: { sender: { columns: userColumns } },
        });

  const map = new Map<string, QuotedMessageSnapshot>();
  for (const rec of records) {
    map.set(rec.id, snapshotFromRow(rec));
  }

  return rows.map((row) => ({
    ...row,
    quotedMessage: row.quotedMessageId ? map.get(row.quotedMessageId) ?? null : null,
  }));
}

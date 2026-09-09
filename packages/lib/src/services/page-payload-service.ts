/**
 * Page-payload server fetcher.
 *
 * Returns the data a dashboard-route Server Component would need to render a
 * single page: the page row itself, the breadcrumb chain (root → page), and a
 * per-page-type context bag (recent channel messages, recent AI chat messages,
 * file metadata, etc.).
 *
 * Authorization is enforced via the canonical `accessible_page_ids_for_user`
 * function — if the page is not in the caller's accessible set, the call throws.
 *
 * Composes inside a transaction when one is provided (so `loadAppShell` gets a
 * single-tx app shell), or opens its own transaction otherwise.
 */
import { db } from '@pagespace/db/db';
import { and, eq, ne, desc, sql } from '@pagespace/db/operators';
import { channelMessages } from '@pagespace/db/schema/chat';
import { pages } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import type {
  PagePayload,
  BreadcrumbEntry,
  PagePayloadContext,
  ChannelMessageSummary,
  ChatMessageSummary,
  Page,
} from '../types';
import { PageType } from '../utils/enums';
import { readSheetDocument } from '../sheets/store';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Runner = typeof db | Tx;

const RECENT_MESSAGE_LIMIT = 50;

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toIsoRequired(value: Date): string {
  return value.toISOString();
}

async function ensurePageAccessible(
  runner: Runner,
  userId: string,
  pageId: string,
): Promise<void> {
  const result = await runner.execute<{ allowed: boolean }>(
    sql`SELECT EXISTS(SELECT 1 FROM accessible_page_ids_for_user(${userId}) WHERE page_id = ${pageId}) AS allowed`,
  );
  const allowed = result.rows[0]?.allowed ?? false;
  if (!allowed) {
    throw new Error(`loadPagePayload: page ${pageId} is not accessible to user ${userId}`);
  }
}

async function fetchPageRow(runner: Runner, pageId: string): Promise<Page> {
  const rows = await runner
    .select()
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`loadPagePayload: page not found (id=${pageId})`);
  }

  const row = rows[0];
  return {
    id: row.id,
    title: row.title,
    type: row.type as PageType,
    content: row.content,
    position: row.position,
    isTrashed: row.isTrashed,
    createdAt: toIsoRequired(row.createdAt),
    updatedAt: toIsoRequired(row.updatedAt),
    revision: row.revision ?? undefined,
    stateHash: row.stateHash,
    trashedAt: toIso(row.trashedAt),
    driveId: row.driveId,
    parentId: row.parentId,
    originalParentId: row.originalParentId,
    fileSize: row.fileSize ?? undefined,
    mimeType: row.mimeType ?? undefined,
    originalFileName: row.originalFileName ?? undefined,
    filePath: row.filePath ?? undefined,
    fileMetadata:
      (row.fileMetadata as Page['fileMetadata']) ?? undefined,
    processingStatus:
      (row.processingStatus as Page['processingStatus']) ?? undefined,
    processingError: row.processingError ?? undefined,
    processedAt: toIso(row.processedAt) ?? undefined,
    extractionMethod:
      (row.extractionMethod as Page['extractionMethod']) ?? undefined,
    extractionMetadata:
      (row.extractionMetadata as Page['extractionMetadata']) ?? undefined,
    contentHash: row.contentHash ?? undefined,
  };
}

async function fetchBreadcrumb(
  runner: Runner,
  userId: string,
  pageId: string,
): Promise<BreadcrumbEntry[]> {
  // Walk from the requested page up to the drive root using a recursive CTE.
  // ORDER BY depth DESC produces root → child → ... → page (the natural reading order).
  // Depth is capped so a malformed parentId cycle cannot cause runaway recursion —
  // real page trees are never this deep.
  //
  // Ancestor metadata (title, type) is redacted for any crumb entry the caller
  // is NOT authorized to view via accessible_page_ids_for_user. An explicit
  // page grant on a nested page would otherwise leak parent-folder titles the
  // user has no right to see.
  const result = await runner.execute<{
    id: string;
    title: string | null;
    type: string | null;
  }>(sql`
    WITH RECURSIVE crumb AS (
      SELECT p.id, p."parentId", 0 AS depth
      FROM pages p
      WHERE p.id = ${pageId}
      UNION ALL
      SELECT parent.id, parent."parentId", c.depth + 1
      FROM pages parent
      JOIN crumb c ON c."parentId" = parent.id
      WHERE c.depth < 128
    ),
    allowed AS (
      SELECT page_id FROM accessible_page_ids_for_user(${userId})
    )
    SELECT
      c.id,
      CASE WHEN a.page_id IS NOT NULL THEN p.title ELSE NULL END AS title,
      CASE WHEN a.page_id IS NOT NULL THEN p.type  ELSE NULL END AS type
    FROM crumb c
    JOIN pages p ON p.id = c.id
    LEFT JOIN allowed a ON a.page_id = c.id
    ORDER BY c.depth DESC
  `);

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    type: row.type ? (row.type as PageType) : null,
  }));
}

async function fetchChannelMessages(
  runner: Runner,
  pageId: string,
): Promise<ChannelMessageSummary[]> {
  const rows = await runner
    .select({
      id: channelMessages.id,
      pageId: channelMessages.pageId,
      userId: channelMessages.userId,
      content: channelMessages.content,
      createdAt: channelMessages.createdAt,
      isActive: channelMessages.isActive,
    })
    .from(channelMessages)
    .where(and(eq(channelMessages.pageId, pageId), eq(channelMessages.isActive, true)))
    .orderBy(desc(channelMessages.createdAt))
    .limit(RECENT_MESSAGE_LIMIT);

  // Reverse so the oldest comes first — natural read order for chat UIs.
  return rows
    .map((row) => ({
      id: row.id,
      pageId: row.pageId,
      userId: row.userId,
      content: row.content,
      createdAt: toIsoRequired(row.createdAt),
      isActive: row.isActive,
    }))
    .reverse();
}

async function fetchChatMessages(
  runner: Runner,
  pageId: string,
): Promise<ChatMessageSummary[]> {
  // Excludes 'streaming' placeholders — this is a model-facing AI-payload context bag, not a
  // client history view, so an empty mid-flight row would be pure noise. See Server Stream
  // Durability epic PR 2.
  //
  // One `messages` table since the message-table merge (epic "Agent-Session
  // Single Source of Truth", Phase 4 / D6). Page scope is the JOIN —
  // `conversations.type = 'page'` AND `conversations.contextId = pageId` —
  // because a row's page is its CONVERSATION's page. The emitted `pageId` is
  // therefore the argument itself, which is what the join proves it equals.
  const rows = await runner
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      isActive: messages.isActive,
      userId: messages.userId,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(
      eq(conversations.type, 'page'),
      eq(conversations.contextId, pageId),
      eq(messages.isActive, true),
      ne(messages.status, 'streaming')
    ))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(RECENT_MESSAGE_LIMIT);

  return rows
    .map((row) => ({
      id: row.id,
      pageId,
      conversationId: row.conversationId,
      role: row.role,
      content: row.content,
      createdAt: toIsoRequired(row.createdAt),
      isActive: row.isActive,
      userId: row.userId,
    }))
    .reverse();
}

async function buildContext(runner: Runner, page: Page): Promise<PagePayloadContext> {
  switch (page.type) {
    case PageType.CHANNEL: {
      const messages = await fetchChannelMessages(runner, page.id);
      return { channelMessages: messages };
    }
    case PageType.AI_CHAT: {
      const messages = await fetchChatMessages(runner, page.id);
      return { chatMessages: messages };
    }
    case PageType.SHEET:
      return { sheet: { contentMode: 'html' } };
    case PageType.DOCUMENT:
      return { document: { contentMode: 'html' } };
    case PageType.FILE:
      return {
        file: {
          fileSize: page.fileSize ?? null,
          mimeType: page.mimeType ?? null,
          originalFileName: page.originalFileName ?? null,
          processingStatus: page.processingStatus ?? null,
        },
      };
    default:
      return {};
  }
}

export async function loadPagePayload(
  userId: string,
  pageId: string,
  tx?: Tx,
): Promise<PagePayload> {
  if (!userId) throw new Error('loadPagePayload: userId is required');
  if (!pageId) throw new Error('loadPagePayload: pageId is required');

  const run = async (runner: Runner): Promise<PagePayload> => {
    await ensurePageAccessible(runner, userId, pageId);
    const page = await fetchPageRow(runner, pageId);

    // A sheet's content is generated from its rows, not read from the column.
    //
    // Rows are the source of truth for sheets; `pages.content` is a fallback
    // that only matters until a sheet has been materialised. Serving the
    // projection here is what lets the editor — and everything else that speaks
    // the document format — keep working unchanged while writes go to rows. It
    // also closes the split where a form submission landed in rows and was
    // invisible to the person who owned the sheet.
    if (page.type === PageType.SHEET) {
      const projected = await readSheetDocument(pageId, runner as never);
      if (projected !== null) page.content = projected;
    }
    const [breadcrumb, context] = await Promise.all([
      fetchBreadcrumb(runner, userId, pageId),
      buildContext(runner, page),
    ]);
    return { page, breadcrumb, context };
  };

  if (tx) return run(tx);
  return await db.transaction((newTx) => run(newTx));
}

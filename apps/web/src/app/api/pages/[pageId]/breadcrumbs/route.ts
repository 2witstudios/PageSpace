import { NextResponse } from 'next/server';
import { decodeToken, canUserViewPage } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { pages, db, drives, sql } from '@pagespace/db';

type BreadcrumbPage = (typeof pages.$inferSelect) & { drive: { id: string; slug: string; name: string } | null };

type QueryResultRow = {
  id: string;
  title: string;
  type: 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'FILE' | 'SHEET';
  content: string;
  isPaginated: boolean;
  pageSize: string;
  margins: string;
  showPageNumbers: boolean;
  showHeaders: boolean;
  showFooters: boolean;
  position: number;
  isTrashed: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  systemPrompt: string | null;
  enabledTools: unknown;
  fileSize: number | null;
  mimeType: string | null;
  originalFileName: string | null;
  filePath: string | null;
  fileMetadata: unknown;
  processingStatus: string | null;
  processingError: string | null;
  processedAt: Date | null;
  extractionMethod: string | null;
  extractionMetadata: unknown;
  contentHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  trashedAt: Date | null;
  driveId: string;
  parentId: string | null;
  originalParentId: string | null;
  drive_id: string | null;
  drive_slug: string | null;
  drive_name: string | null;
  depth: number;
  path: string[];
};

async function getBreadcrumbs(pageId: string): Promise<BreadcrumbPage[]> {
  const MAX_DEPTH = 100;

  // Use recursive CTE to fetch all ancestors in a single query
  const result = await db.execute<QueryResultRow>(sql`
    WITH RECURSIVE page_ancestors AS (
      -- Base case: start with the requested page
      SELECT
        p.*,
        d.id as drive_id,
        d.slug as drive_slug,
        d.name as drive_name,
        1 as depth,
        ARRAY[p.id] as path
      FROM ${pages} p
      LEFT JOIN ${drives} d ON p."driveId" = d.id
      WHERE p.id = ${pageId}

      UNION ALL

      -- Recursive case: get parent pages
      SELECT
        p.*,
        d.id as drive_id,
        d.slug as drive_slug,
        d.name as drive_name,
        pa.depth + 1,
        pa.path || p.id
      FROM ${pages} p
      LEFT JOIN ${drives} d ON p."driveId" = d.id
      INNER JOIN page_ancestors pa ON p.id = pa."parentId"
      WHERE
        pa.depth < ${MAX_DEPTH}
        AND NOT (p.id = ANY(pa.path))  -- Cycle detection
    )
    SELECT * FROM page_ancestors
    ORDER BY depth DESC
  `);

  // Transform the result to match BreadcrumbPage type
  const breadcrumbs: BreadcrumbPage[] = result.rows.map((row: QueryResultRow): BreadcrumbPage => ({
    id: row.id,
    title: row.title,
    type: row.type as typeof pages.$inferSelect.type,
    content: row.content,
    isPaginated: row.isPaginated,
    pageSize: row.pageSize,
    margins: row.margins,
    showPageNumbers: row.showPageNumbers,
    showHeaders: row.showHeaders,
    showFooters: row.showFooters,
    position: row.position,
    isTrashed: row.isTrashed,
    aiProvider: row.aiProvider,
    aiModel: row.aiModel,
    systemPrompt: row.systemPrompt,
    enabledTools: row.enabledTools as typeof pages.$inferSelect.enabledTools,
    fileSize: row.fileSize,
    mimeType: row.mimeType,
    originalFileName: row.originalFileName,
    filePath: row.filePath,
    fileMetadata: row.fileMetadata as typeof pages.$inferSelect.fileMetadata,
    processingStatus: row.processingStatus,
    processingError: row.processingError,
    processedAt: row.processedAt,
    extractionMethod: row.extractionMethod,
    extractionMetadata: row.extractionMetadata as typeof pages.$inferSelect.extractionMetadata,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    trashedAt: row.trashedAt,
    driveId: row.driveId,
    parentId: row.parentId,
    originalParentId: row.originalParentId,
    drive: row.drive_id && row.drive_slug && row.drive_name ? {
      id: row.drive_id,
      slug: row.drive_slug,
      name: row.drive_name,
    } : null,
  }));

  return breadcrumbs;
}

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded?.userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const canView = await canUserViewPage(decoded.userId, pageId);
  if (!canView) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const breadcrumbs = await getBreadcrumbs(pageId);
  return NextResponse.json(breadcrumbs);
}

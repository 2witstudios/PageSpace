// Minimal pg Pool interface, narrower than @types/pg's full surface
export interface PgPoolClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

interface PgPool {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

import pg from 'pg';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { buildAdminPgTypes, type PgTypesConfig } from './admin-pg-types';
import { decideExtractionWrite, EXTRACTABLE_PAGE_TYPE } from './extraction-write-guard';
const { Pool } = pg as unknown as {
  Pool: new (config: { connectionString: string; max: number; types?: PgTypesConfig }) => PgPool;
};

let pool: PgPool | null = null;

function getPool(): PgPool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured');
    }
    pool = new Pool({ connectionString, max: 5 });
  }
  return pool;
}

export function getPoolForWorker(): PgPool {
  return getPool();
}

// Admin PG (trust plane) pool — separate server, separate identity: the
// processor connects as admin_processor_user (admin_chainer + admin_siem)
// via its service-scoped ADMIN_DATABASE_URL (#890 Phase 2). Small max: the
// only consumer is the single-writer audit chainer.
// timestamp-without-tz columns parse as UTC (buildAdminPgTypes): raw-pg
// reads on this pool feed hash recomputation, which must match drizzle's
// UTC wall-clock storage regardless of process TZ.
let adminPool: PgPool | null = null;

export function getAdminPoolForWorker(): PgPool {
  if (!adminPool) {
    const connectionString = process.env.ADMIN_DATABASE_URL;
    if (!connectionString) {
      throw new Error('ADMIN_DATABASE_URL is not configured');
    }
    adminPool = new Pool({ connectionString, max: 2, types: buildAdminPgTypes() });
  }
  return adminPool;
}

export async function setPageProcessing(pageId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      'UPDATE pages SET "processingStatus" = $1 WHERE id = $2',
      ['processing', pageId]
    );
  } finally {
    client.release();
  }
}

/**
 * Record a finished text extraction.
 *
 * One statement, so the type test and the write cannot disagree: the UPDATE
 * takes the row lock itself and evaluates `type` against the same row version
 * it writes. A page converted to a DOCUMENT between enqueue and here keeps its
 * authored body — the CASE leaves `content` untouched — while the processing
 * bookkeeping still lands, so it does not sit "processing" forever and get
 * marked failed by the stuck-page reconciler.
 */
export async function setPageCompleted(
  pageId: string,
  content: string,
  metadata: Record<string, unknown> | null,
  extractionMethod: 'text' | 'ocr' | 'visual' | 'hybrid' | 'none' = 'text'
): Promise<void> {
  const client = await getPool().connect();
  try {
    const result = await client.query(
      `UPDATE pages
          SET content = CASE WHEN type = $1 THEN $2 ELSE content END,
              "processingStatus" = $3,
              "extractionMethod" = $4,
              "extractionMetadata" = $5::jsonb,
              "processedAt" = NOW()
        WHERE id = $6
      RETURNING type`,
      [
        EXTRACTABLE_PAGE_TYPE,
        content,
        'completed',
        extractionMethod,
        metadata ? JSON.stringify(metadata) : null,
        pageId,
      ]
    );

    const decision = decideExtractionWrite({
      pageType: result.rows.length ? String(result.rows[0].type) : null,
    });

    if (decision.action === 'skip-all') {
      loggers.processor.warn(
        `extraction write skipped: page ${pageId} no longer exists`
      );
    } else if (decision.action === 'skip-content') {
      loggers.processor.warn(
        `extraction content write refused: page ${pageId} is a ${decision.pageType}, not a ${EXTRACTABLE_PAGE_TYPE} — recorded extraction status only`
      );
    }
  } finally {
    client.release();
  }
}

export async function setPageVisual(pageId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      'UPDATE pages SET "processingStatus" = $1, "extractionMethod" = $2, "processedAt" = NOW() WHERE id = $3',
      ['visual', 'visual', pageId]
    );
  } finally {
    client.release();
  }
}

export async function setPageVideoProcessed(
  pageId: string,
  meta: { duration?: number; width?: number; height?: number; thumbnailKey?: string },
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      'UPDATE pages SET "extractionMetadata" = $1::jsonb, "processedAt" = NOW() WHERE id = $2',
      [JSON.stringify(meta), pageId],
    );
  } finally {
    client.release();
  }
}

export async function setPageFailed(pageId: string, errorMessage: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      'UPDATE pages SET "processingStatus" = $1, "processingError" = $2, "processedAt" = NOW() WHERE id = $3',
      ['failed', errorMessage, pageId]
    );
  } finally {
    client.release();
  }
}

export async function getPageForIngestion(pageId: string): Promise<{
  id: string;
  contentHash: string;
  mimeType: string | null;
  originalFileName: string | null;
} | null> {
  const client = await getPool().connect();
  try {
    const result = await client.query(
      'SELECT id, "filePath" as "contentHash", "mimeType", "originalFileName" FROM pages WHERE id = $1 LIMIT 1',
      [pageId]
    );
    if (!result.rows.length) return null;
    return result.rows[0] as {
      id: string;
      contentHash: string;
      mimeType: string | null;
      originalFileName: string | null;
    };
  } finally {
    client.release();
  }
}

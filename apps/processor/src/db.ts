/**
 * Minimal type definitions for pg module
 * Keeps processor build self-contained without requiring @types/pg
 */
interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}

interface PoolClient {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

interface Pool {
  connect(): Promise<PoolClient>;
}

interface PoolConstructor {
  new (config: { connectionString: string; max?: number }): Pool;
}

// Dynamic import to avoid bundling issues - pg is a CommonJS module
const { Pool: PgPool } = require('pg') as { Pool: PoolConstructor };

// Simple PG helper for processor-owned updates to page processing fields
// Uses DATABASE_URL env var (same as PgBoss)

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured');
    }
    pool = new PgPool({ connectionString, max: 5 });
  }
  return pool;
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

export async function setPageCompleted(
  pageId: string,
  content: string,
  metadata: Record<string, unknown> | null,
  extractionMethod: 'text' | 'ocr' | 'visual' | 'hybrid' | 'none' = 'text'
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      'UPDATE pages SET content = $1, "processingStatus" = $2, "extractionMethod" = $3, "extractionMetadata" = $4::jsonb, "processedAt" = NOW() WHERE id = $5',
      [content, 'completed', extractionMethod, metadata ? JSON.stringify(metadata) : null, pageId]
    );
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
    if (result.rowCount === 0) return null;
    return result.rows[0];
  } finally {
    client.release();
  }
}

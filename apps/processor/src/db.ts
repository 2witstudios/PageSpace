// Import pg without type dependency to keep processor build self-contained
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool }: any = require('pg');

// Simple PG helper for processor-owned updates to page processing fields
// Uses DATABASE_URL env var (same as PgBoss)

let pool: any = null;

function getPool(): any {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured');
    }
    pool = new Pool({ connectionString, max: 5 });
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
  metadata: any | null,
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

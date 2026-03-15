// Minimal pg Pool interface to keep processor build self-contained without @types/pg
interface PgPoolClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

interface PgPool {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

import pg from 'pg';
const { Pool } = pg as unknown as { Pool: new (config: { connectionString: string; max: number }) => PgPool };

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

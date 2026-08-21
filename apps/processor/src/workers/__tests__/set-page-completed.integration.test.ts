/**
 * The FILE fence in `setPageCompleted` is a SQL `CASE` expression, so a mocked
 * pg driver can only pin the statement's shape — it cannot evaluate it. This
 * suite executes the real statement against a real Postgres and asserts what
 * actually matters: a page that is no longer a FILE keeps the body a person
 * wrote, while its extraction bookkeeping still lands.
 *
 * That combination is the whole point. Refusing the write and ALSO skipping the
 * bookkeeping would leave the page stuck "processing" until the stuck-page
 * reconciler marked it failed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { requireDbUrl } from '@pagespace/db/test/require-db';
import { setPageCompleted } from '../../db';
import { getPoolForWorker } from '../../db';

const url = process.env.DATABASE_URL;
requireDbUrl(url, 'DATABASE_URL', 'set-page-completed.integration.test.ts');

const pool = getPoolForWorker();

const driveId = `drv_${createId()}`;
const userId = `usr_${createId()}`;

async function exec(text: string, values?: unknown[]) {
  const client = await pool.connect();
  try {
    return await client.query(text, values);
  } finally {
    client.release();
  }
}

async function insertPage(type: string, content: string): Promise<string> {
  const id = `pg_${createId()}`;
  await exec(
    `INSERT INTO pages (id, title, type, content, "driveId", position, "isTrashed",
                        "processingStatus", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 1, false, 'processing', NOW(), NOW())`,
    [id, `page ${id}`, type, content, driveId]
  );
  return id;
}

async function readPage(id: string) {
  const result = await exec(
    'SELECT content, "processingStatus", "extractionMethod", "processedAt" FROM pages WHERE id = $1',
    [id]
  );
  return result.rows[0] as {
    content: string;
    processingStatus: string;
    extractionMethod: string | null;
    processedAt: Date | null;
  };
}

beforeAll(async () => {
  await exec(
    `INSERT INTO users (id, email, name, "createdAt", "updatedAt")
     VALUES ($1, $2, 'Fence Test', NOW(), NOW())`,
    [userId, `fence-${userId}@example.test`]
  );
  await exec(
    `INSERT INTO drives (id, name, slug, "ownerId", "createdAt", "updatedAt")
     VALUES ($1, 'Fence Test Drive', $2, $3, NOW(), NOW())`,
    [driveId, `fence-${driveId}`, userId]
  );
});

afterAll(async () => {
  await exec('DELETE FROM pages WHERE "driveId" = $1', [driveId]);
  await exec('DELETE FROM drives WHERE id = $1', [driveId]);
  await exec('DELETE FROM users WHERE id = $1', [userId]);
});

describe('setPageCompleted (real Postgres)', () => {
  it('given a FILE page, writes the extracted text into the body', async () => {
    const pageId = await insertPage('FILE', '');

    await setPageCompleted(pageId, 'text pulled out of the PDF', { pages: 3 }, 'text');

    const page = await readPage(pageId);
    expect(page.content).toBe('text pulled out of the PDF');
    expect(page.processingStatus).toBe('completed');
    expect(page.extractionMethod).toBe('text');
  });

  it('given a page converted to DOCUMENT after enqueue, leaves the authored body intact', async () => {
    const authored = '<p>a paragraph a person wrote after converting the file</p>';
    const pageId = await insertPage('DOCUMENT', authored);

    await setPageCompleted(pageId, 'text pulled out of the PDF', { pages: 3 }, 'text');

    const page = await readPage(pageId);
    expect(page.content).toBe(authored);
    // The bookkeeping still lands, so the page stops showing as processing.
    expect(page.processingStatus).toBe('completed');
    expect(page.extractionMethod).toBe('text');
    expect(page.processedAt).not.toBeNull();
  });

  it.each(['FOLDER', 'AI_CHAT', 'CHANNEL', 'CANVAS', 'SHEET', 'TASK_LIST'])(
    'given a %s page, leaves the body intact',
    async (type) => {
      const authored = `content belonging to a ${type}`;
      const pageId = await insertPage(type, authored);

      await setPageCompleted(pageId, 'extracted text', null, 'text');

      expect((await readPage(pageId)).content).toBe(authored);
    }
  );

  it('given a page that no longer exists, writes nothing and does not throw', async () => {
    await expect(
      setPageCompleted(`pg_${createId()}`, 'extracted text', null, 'text')
    ).resolves.toBeUndefined();
  });
});

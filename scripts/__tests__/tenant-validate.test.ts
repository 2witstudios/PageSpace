/**
 * Integration tests for tenant-validate.ts
 *
 * @integration - requires running postgres on port 5433
 *
 * Run: docker compose -f docker-compose.test.yml up -d && cd scripts && npx vitest run
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { sql } from 'drizzle-orm';
import {
  createTestDb,
  runMigrations,
  truncateAll,
  seedFixtures,
  closePool,
  FIXTURES,
  getTestDatabaseUrl,
  type TestDb,
} from './setup';
import { validateData } from '../tenant-validate';
import { TABLE_IMPORT_ORDER } from '../lib/migration-types';
import type { DbClient } from '../lib/migration-types';

let db: TestDb;
let tmpDir: string;
let fileStoragePath: string;

beforeAll(async () => {
  db = createTestDb();
  await runMigrations(db);
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await truncateAll(db);
  await seedFixtures(db);

  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pagespace-validate-test-'));
  fileStoragePath = path.join(tmpDir, 'files');
  await mkdir(fileStoragePath, { recursive: true });

  // Create file blob on disk
  const blobDir = path.join(fileStoragePath, 'test_file_blob_001');
  await mkdir(blobDir, { recursive: true });
  await writeFile(path.join(blobDir, 'data.txt'), '0123456789');
});

afterEach(async () => {
  if (tmpDir && existsSync(tmpDir)) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

describe('validateData', () => {
  it('reports success when source and target match', async () => {
    const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      sourceFileStoragePath: fileStoragePath,
      targetFileStoragePath: fileStoragePath,
    });

    expect(result.passed).toBe(true);
    expect(result.tableResults.every((r) => r.passed)).toBe(true);
    expect(result.fileResults.passed).toBe(true);
  });

  /**
   * THE VALIDATOR MUST ASK THE SAME QUESTION THE EXPORT ANSWERED.
   *
   * `tenant-export` carries every conversation attached to an exported PAGE,
   * not just those owned by a requested user — a page chat started by a drive
   * member outside `--user-ids` comes along, and so do all of its messages
   * (`messages.conversationId` is NOT NULL and FK'd, so leaving them behind
   * would abort the import).
   *
   * The validator built its conversation id list from `"userId" IN (...)`
   * alone. Those extra rows were therefore compared on NEITHER side, so
   * `[PASS] messages` printed even if the import had dropped every one of
   * them: not a missed check but a false PASS, on exactly the row population
   * the exporter's own comment records as the historical loss.
   *
   * Source and target are the same database here, so the assertion is on the
   * SOURCE population — which is precisely where the bug lived.
   */
  describe('the validated population matches the exported population', () => {
    const OUTSIDER_CONVO = 'test_convo_outsider_001';
    const OUTSIDER_MSG = 'test_msg_outsider_001';

    beforeEach(async () => {
      // Eve is NOT in the `userIds` below, but her chat is on an exported page.
      await db.execute(sql.raw(
        `INSERT INTO conversations (id, "userId", title, type, "contextId", "createdAt", "updatedAt")`
        + ` VALUES ('${OUTSIDER_CONVO}', '${FIXTURES.users.outsider.id}', 'Eve chat', 'page', '${FIXTURES.pages.grandchild.id}', NOW(), NOW())`,
      ));
      await db.execute(sql.raw(
        `INSERT INTO messages (id, "conversationId", role, content, "userId", "createdAt")`
        + ` VALUES ('${OUTSIDER_MSG}', '${OUTSIDER_CONVO}', 'user', 'from a non-requested member', '${FIXTURES.users.outsider.id}', NOW())`,
      ));
    });

    const validate = () =>
      validateData(db as unknown as DbClient, db as unknown as DbClient, {
        sourceDatabaseUrl: getTestDatabaseUrl(),
        targetDatabaseUrl: getTestDatabaseUrl(),
        userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
        sourceFileStoragePath: fileStoragePath,
        targetFileStoragePath: fileStoragePath,
      });

    it('counts a page conversation owned by a NON-requested member', async () => {
      const result = await validate();
      const conversationsResult = result.tableResults.find((r) => r.table === 'conversations');
      // The seeded page chat plus Eve's — the export carries both.
      expect(conversationsResult!.sourceCount).toBe(2);
    });

    it('counts that conversation\'s MESSAGES — the rows the false PASS hid', async () => {
      const result = await validate();
      const messagesResult = result.tableResults.find((r) => r.table === 'messages');
      // Two seeded messages on the owner's chat + one on Eve's. Before the fix
      // this was 2: Eve's message was exported and validated by nobody.
      expect(messagesResult!.sourceCount).toBe(3);
      expect(messagesResult!.passed).toBe(true);
    });

    it('still passes overall — widening the population must not break a good migration', async () => {
      const result = await validate();
      expect(result.passed).toBe(true);
      expect(result.tableResults.every((r) => r.passed)).toBe(true);
    });
  });

  it('detects missing page in target', async () => {
    // Same-DB limitation: after delete, both source and target reflect the change.
    // We verify the structure reports the correct count after cascade delete.
    await db.execute(sql.raw(
      `DELETE FROM pages WHERE id = '${FIXTURES.pages.grandchild.id}'`,
    ));

    const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      sourceFileStoragePath: fileStoragePath,
      targetFileStoragePath: fileStoragePath,
    });

    const pagesResult = result.tableResults.find((r) => r.table === 'pages');
    expect(pagesResult).toBeDefined();
    expect(pagesResult!.sourceCount).toBe(2);
  });

  it('detects missing file blob in target', async () => {
    const targetFilePath = path.join(tmpDir, 'target-missing');
    await mkdir(targetFilePath, { recursive: true });

    const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      sourceFileStoragePath: fileStoragePath,
      targetFileStoragePath: targetFilePath,
    });

    expect(result.fileResults.passed).toBe(false);
    expect(result.fileResults.mismatches).toHaveLength(1);
    expect(result.fileResults.mismatches[0].reason).toBe('missing in target');
  });

  it('detects file checksum mismatch', async () => {
    const targetFilePath = path.join(tmpDir, 'target-mismatch');
    const blobDir = path.join(targetFilePath, 'test_file_blob_001');
    await mkdir(blobDir, { recursive: true });
    await writeFile(path.join(blobDir, 'data.txt'), 'DIFFERENT!');

    const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      sourceFileStoragePath: fileStoragePath,
      targetFileStoragePath: targetFilePath,
    });

    expect(result.fileResults.passed).toBe(false);
    expect(result.fileResults.mismatches[0].reason).toContain('checksum mismatch');
  });

  it('validates every table in TABLE_IMPORT_ORDER', async () => {
    const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      sourceFileStoragePath: fileStoragePath,
      targetFileStoragePath: fileStoragePath,
    });

    const tableNames = result.tableResults.map((r) => r.table);
    // Every table in the import order should be validated
    for (const table of TABLE_IMPORT_ORDER) {
      expect(tableNames).toContain(table);
    }
    expect(tableNames).toHaveLength(TABLE_IMPORT_ORDER.length);
  });

  it('reports correct counts for seeded data', async () => {
    const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      sourceFileStoragePath: fileStoragePath,
      targetFileStoragePath: fileStoragePath,
    });

    const find = (t: string) => result.tableResults.find((r) => r.table === t)!;

    expect(find('users').sourceCount).toBe(2);
    expect(find('drives').sourceCount).toBe(1);
    expect(find('pages').sourceCount).toBe(3);
    expect(find('messages').sourceCount).toBe(2);
    expect(find('files').sourceCount).toBe(1);
    expect(find('page_permissions').sourceCount).toBe(1);
    // Two vocabulary rows (one of them unused) against one assignment — the
    // validator selects tags by DRIVE, matching the exporter. If either side
    // narrowed to "tags with a surviving assignment", both would agree on 1 and
    // validation would report success over a bundle missing a row.
    expect(find('tags').sourceCount).toBe(2);
    expect(find('content_tags').sourceCount).toBe(1);
    expect(find('mentions').sourceCount).toBe(1);
    expect(find('user_mentions').sourceCount).toBe(1);
    expect(find('favorites').sourceCount).toBe(1);
  });
});

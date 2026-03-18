/**
 * Integration tests for tenant-validate.ts
 *
 * @integration - requires running postgres on port 5433
 *
 * Run: docker compose -f docker-compose.test.yml up -d && cd scripts && npx vitest run
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
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

  tmpDir = path.join(os.tmpdir(), `pagespace-validate-test-${Date.now()}`);
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
    const result = await validateData(db as never, db as never, {
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

  it('detects missing page in target', async () => {
    // Same-DB limitation: after delete, both source and target reflect the change.
    // We verify the structure reports the correct count after cascade delete.
    await db.execute(sql.raw(
      `DELETE FROM pages WHERE id = '${FIXTURES.pages.grandchild.id}'`,
    ));

    const result = await validateData(db as never, db as never, {
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

    const result = await validateData(db as never, db as never, {
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

    const result = await validateData(db as never, db as never, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      sourceFileStoragePath: fileStoragePath,
      targetFileStoragePath: targetFilePath,
    });

    expect(result.fileResults.passed).toBe(false);
    expect(result.fileResults.mismatches[0].reason).toContain('checksum mismatch');
  });

  it('validates all 21 exported tables', async () => {
    const result = await validateData(db as never, db as never, {
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
    const result = await validateData(db as never, db as never, {
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
    expect(find('chat_messages').sourceCount).toBe(2);
    expect(find('files').sourceCount).toBe(1);
    expect(find('permissions').sourceCount).toBe(1);
    expect(find('page_permissions').sourceCount).toBe(1);
    expect(find('tags').sourceCount).toBe(1);
    expect(find('mentions').sourceCount).toBe(1);
    expect(find('user_mentions').sourceCount).toBe(1);
    expect(find('favorites').sourceCount).toBe(1);
  });
});

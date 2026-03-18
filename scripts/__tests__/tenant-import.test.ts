/**
 * Integration tests for tenant-import.ts
 *
 * @integration - requires running postgres on port 5433
 *
 * Run: docker compose -f docker-compose.test.yml up -d && cd scripts && npx vitest run
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
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
import { exportData } from '../tenant-export';
import { runImport, splitSqlStatements } from '../tenant-import';

let db: TestDb;
let tmpDir: string;
let fileStoragePath: string;
let bundleDir: string;

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

  // Create temp dirs
  tmpDir = path.join(os.tmpdir(), `pagespace-import-test-${Date.now()}`);
  fileStoragePath = path.join(tmpDir, 'source-files');
  bundleDir = path.join(tmpDir, 'bundle');
  await mkdir(fileStoragePath, { recursive: true });

  // Create the test file blob on disk
  const blobDir = path.join(fileStoragePath, 'test_file_blob_001');
  await mkdir(blobDir, { recursive: true });
  await writeFile(path.join(blobDir, 'data.txt'), '0123456789');

  // Export a bundle we can import
  await exportData(db as never, {
    userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
    outputDir: bundleDir,
    fileStoragePath,
    databaseUrl: getTestDatabaseUrl(),
    dryRun: false,
  });
});

describe('splitSqlStatements', () => {
  it('splits multi-line INSERT statements correctly', () => {
    const sql = `-- comment
BEGIN;

INSERT INTO "users" ("id", "name")
VALUES
  ('a', 'Alice'),
  ('b', 'Bob')
ON CONFLICT DO NOTHING;

COMMIT;
`;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(3); // BEGIN, INSERT, COMMIT
    expect(stmts[1]).toContain('INSERT INTO');
    expect(stmts[1]).toContain('Alice');
  });
});

describe('runImport', () => {
  it('imports all rows from a valid export bundle', async () => {
    // Truncate to simulate a fresh target database
    await truncateAll(db);

    const targetFilePath = path.join(tmpDir, 'target-files');
    await mkdir(targetFilePath, { recursive: true });

    const result = await runImport({
      bundleDir,
      databaseUrl: getTestDatabaseUrl(),
      fileStoragePath: targetFilePath,
      dryRun: false,
    });

    expect(result.rowsImported).toBeGreaterThan(0);
    expect(result.checksumMismatches).toHaveLength(0);

    // Verify data exists in target
    const usersResult = await db.execute(sql.raw(
      `SELECT id FROM users WHERE id IN ('${FIXTURES.users.owner.id}', '${FIXTURES.users.member.id}')`,
    ));
    expect(usersResult.rows).toHaveLength(2);

    const drivesResult = await db.execute(sql.raw(
      `SELECT id FROM drives WHERE id = '${FIXTURES.drives.shared.id}'`,
    ));
    expect(drivesResult.rows).toHaveLength(1);

    const pagesResult = await db.execute(sql.raw(
      `SELECT id, "parentId" FROM pages WHERE "driveId" = '${FIXTURES.drives.shared.id}' ORDER BY position`,
    ));
    expect(pagesResult.rows).toHaveLength(3);
  });

  it('preserves page tree structure (parent references)', async () => {
    await truncateAll(db);

    const targetFilePath = path.join(tmpDir, 'target-files-tree');
    await mkdir(targetFilePath, { recursive: true });

    await runImport({
      bundleDir,
      databaseUrl: getTestDatabaseUrl(),
      fileStoragePath: targetFilePath,
      dryRun: false,
    });

    // Verify parent-child relationships
    const pagesResult = await db.execute(sql.raw(
      `SELECT id, "parentId" FROM pages WHERE "driveId" = '${FIXTURES.drives.shared.id}'`,
    ));
    const pages = pagesResult.rows as Record<string, unknown>[];
    const pageMap = new Map(pages.map((p) => [p.id, p.parentId]));

    expect(pageMap.get(FIXTURES.pages.root.id)).toBeNull();
    expect(pageMap.get(FIXTURES.pages.child.id)).toBe(FIXTURES.pages.root.id);
    expect(pageMap.get(FIXTURES.pages.grandchild.id)).toBe(FIXTURES.pages.child.id);
  });

  it('is idempotent - re-import skips existing rows', async () => {
    // Data is already seeded, so importing again should skip all rows
    const targetFilePath = path.join(tmpDir, 'target-files-idem');
    await mkdir(targetFilePath, { recursive: true });

    const result = await runImport({
      bundleDir,
      databaseUrl: getTestDatabaseUrl(),
      fileStoragePath: targetFilePath,
      dryRun: false,
    });

    // ON CONFLICT DO NOTHING means rowsImported will be 0 for duplicate data
    // The import should complete without error
    expect(result.checksumMismatches).toHaveLength(0);

    // Verify no duplicates
    const usersResult = await db.execute(sql.raw(`SELECT count(*) as count FROM users`));
    const userCount = Number((usersResult.rows as Record<string, unknown>[])[0].count);
    // Should have 3 users (owner, member, outsider from seed) - not 5
    expect(userCount).toBe(3);
  });

  it('copies file blobs to target storage path', async () => {
    await truncateAll(db);

    const targetFilePath = path.join(tmpDir, 'target-files-blobs');
    await mkdir(targetFilePath, { recursive: true });

    const result = await runImport({
      bundleDir,
      databaseUrl: getTestDatabaseUrl(),
      fileStoragePath: targetFilePath,
      dryRun: false,
    });

    expect(result.filesImported).toBe(1);

    const destBlobPath = path.join(targetFilePath, 'test_file_blob_001', 'data.txt');
    expect(existsSync(destBlobPath)).toBe(true);

    const content = await readFile(destBlobPath, 'utf-8');
    expect(content).toBe('0123456789');
  });

  it('validates manifest checksums and reports mismatches', async () => {
    // Corrupt a file in the bundle
    const corruptedBlobPath = path.join(bundleDir, 'files', 'test_file_blob_001', 'data.txt');
    await writeFile(corruptedBlobPath, 'CORRUPTED!');

    await truncateAll(db);

    const targetFilePath = path.join(tmpDir, 'target-files-corrupt');
    await mkdir(targetFilePath, { recursive: true });

    const result = await runImport({
      bundleDir,
      databaseUrl: getTestDatabaseUrl(),
      fileStoragePath: targetFilePath,
      dryRun: false,
    });

    // Should report checksum mismatch but still complete
    expect(result.checksumMismatches).toHaveLength(1);
    expect(result.checksumMismatches[0].path).toContain('test_file_blob_001');
  });

  it('dry-run reports what would be imported without writing', async () => {
    await truncateAll(db);

    const result = await runImport({
      bundleDir,
      databaseUrl: getTestDatabaseUrl(),
      fileStoragePath: path.join(tmpDir, 'target-dry'),
      dryRun: true,
    });

    expect(result.rowsImported).toBe(0);
    expect(result.filesImported).toBe(0);

    // Verify no data was written
    const usersResult = await db.execute(sql.raw(`SELECT count(*) as count FROM users`));
    expect(Number((usersResult.rows as Record<string, unknown>[])[0].count)).toBe(0);
  });

  it('rolls back on SQL error (all-or-nothing)', async () => {
    await truncateAll(db);

    // Create a bundle with invalid SQL
    const badBundleDir = path.join(tmpDir, 'bad-bundle');
    await mkdir(badBundleDir, { recursive: true });

    // Write a manifest
    const manifest = JSON.parse(await readFile(path.join(bundleDir, 'manifest.json'), 'utf-8'));
    manifest.fileChecksums = [];
    await writeFile(path.join(badBundleDir, 'manifest.json'), JSON.stringify(manifest));

    // Write SQL with an error (referencing a non-existent column)
    await writeFile(
      path.join(badBundleDir, 'data.sql'),
      `BEGIN;
INSERT INTO "users" ("id", "name", "email", "password", "provider", "createdAt", "updatedAt")
VALUES ('test1', 'Test', 'test@test.com', 'hash', 'email', NOW(), NOW())
ON CONFLICT DO NOTHING;
INSERT INTO "nonexistent_table" ("id") VALUES ('x');
COMMIT;`,
    );

    await expect(
      runImport({
        bundleDir: badBundleDir,
        databaseUrl: getTestDatabaseUrl(),
        fileStoragePath: path.join(tmpDir, 'target-rollback'),
        dryRun: false,
      }),
    ).rejects.toThrow();

    // Verify rollback - no users should exist
    const usersResult = await db.execute(sql.raw(`SELECT count(*) as count FROM users`));
    expect(Number((usersResult.rows as Record<string, unknown>[])[0].count)).toBe(0);
  });
});

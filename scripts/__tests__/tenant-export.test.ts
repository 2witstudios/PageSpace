/**
 * Integration tests for tenant-export.ts
 *
 * @integration - requires running postgres on port 5433
 *
 * Run: docker compose -f docker-compose.test.yml up -d && cd scripts && npx vitest run
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
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
import { exportData, discoverDrives } from '../tenant-export';
import type { ExportManifest } from '../lib/migration-types';

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

  // Create temp dirs for output and file storage
  tmpDir = path.join(os.tmpdir(), `pagespace-export-test-${Date.now()}`);
  fileStoragePath = path.join(tmpDir, 'source-files');
  await mkdir(fileStoragePath, { recursive: true });

  // Create the test file blob on disk
  const blobDir = path.join(fileStoragePath, 'test_file_blob_001');
  await mkdir(blobDir, { recursive: true });
  await writeFile(path.join(blobDir, 'data.txt'), '0123456789'); // 10 bytes
});

afterEach(async () => {
  if (tmpDir && existsSync(tmpDir)) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

describe('discoverDrives', () => {
  it('discovers drives where specified users are members', async () => {
    const driveIds = await discoverDrives(db as never, [
      FIXTURES.users.owner.id,
      FIXTURES.users.member.id,
    ]);

    expect(driveIds).toHaveLength(1);
    expect(driveIds).toContain(FIXTURES.drives.shared.id);
  });

  it('returns empty array for users with no drives', async () => {
    const driveIds = await discoverDrives(db as never, ['nonexistent_user']);
    expect(driveIds).toHaveLength(0);
  });
});

describe('exportData', () => {
  it('exports correct users', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.users).toBe(2);
    expect(result.manifest.tableCounts.userProfiles).toBe(2);
  });

  it('exports the shared drive', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.drives).toBe(1);
  });

  it('exports only specified users drive memberships', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.driveMembers).toBe(2);
  });

  it('exports all pages in drive maintaining tree structure', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.pages).toBe(3);

    // Verify SQL contains parent references
    expect(result.sqlStatements).toContain(FIXTURES.pages.root.id);
    expect(result.sqlStatements).toContain(FIXTURES.pages.child.id);
    expect(result.sqlStatements).toContain(FIXTURES.pages.grandchild.id);
  });

  it('exports chat messages', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.chatMessages).toBe(2);
  });

  it('exports files and copies blobs', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.files).toBe(1);
    expect(result.manifest.tableCounts.filePages).toBe(1);
    expect(result.manifest.fileChecksums).toHaveLength(1);
    expect(result.manifest.totalFileBytes).toBe(10);

    // Verify blob was copied
    const destPath = path.join(outputDir, 'files', 'test_file_blob_001', 'data.txt');
    expect(existsSync(destPath)).toBe(true);
  });

  it('exports permissions', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.permissions).toBe(1);
    expect(result.manifest.tableCounts.pagePermissions).toBe(1);
  });

  it('exports tags and page-tag links', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.tags).toBe(1);
    expect(result.manifest.tableCounts.pageTags).toBe(1);
  });

  it('exports mentions and user mentions', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.mentions).toBe(1);
    expect(result.manifest.tableCounts.userMentions).toBe(1);
  });

  it('exports favorites', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.favorites).toBe(1);
  });

  it('produces correct manifest with row counts', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    // Verify manifest file was written
    const manifestPath = path.join(outputDir, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);

    const manifestFromDisk: ExportManifest = JSON.parse(
      await readFile(manifestPath, 'utf-8'),
    );
    expect(manifestFromDisk.version).toBe(1);
    expect(manifestFromDisk.exportedUsers).toEqual([
      FIXTURES.users.owner.id,
      FIXTURES.users.member.id,
    ]);
    expect(manifestFromDisk.tableCounts).toEqual(result.manifest.tableCounts);
  });

  it('writes data.sql with INSERT statements', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    const sqlPath = path.join(outputDir, 'data.sql');
    expect(existsSync(sqlPath)).toBe(true);

    const sqlContent = await readFile(sqlPath, 'utf-8');
    expect(sqlContent).toContain('INSERT INTO "users"');
    expect(sqlContent).toContain('INSERT INTO "drives"');
    expect(sqlContent).toContain('INSERT INTO "pages"');
    expect(sqlContent).toContain('ON CONFLICT DO NOTHING');
    expect(sqlContent).toContain('BEGIN;');
    expect(sqlContent).toContain('COMMIT;');
  });

  it('dry-run does not write any files', async () => {
    const outputDir = path.join(tmpDir, 'dryrun-bundle');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: true,
    });

    // Should still return counts
    expect(result.manifest.tableCounts.users).toBe(2);
    expect(result.manifest.tableCounts.pages).toBe(3);

    // But no files should be created
    expect(existsSync(path.join(outputDir, 'data.sql'))).toBe(false);
    expect(existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
  });

  it('handles FK references to non-exported users gracefully', async () => {
    // The outsider user is not in the export set, but pagePermissions.grantedBy
    // references the owner user (who IS exported). Test the nullification logic
    // for a case where grantedBy points to a non-exported user.
    const { sql: sqlFn } = await import('drizzle-orm');
    await db.execute(sqlFn.raw(
      `UPDATE page_permissions SET "grantedBy" = '${FIXTURES.users.outsider.id}' WHERE id = '${FIXTURES.pagePermissions.pp1.id}'`,
    ));

    const outputDir = path.join(tmpDir, 'bundle-fk');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    // The grantedBy should be nulled out since outsider is not exported
    expect(result.sqlStatements).toContain('page_permissions');
    // The export should complete without error
    expect(result.manifest.tableCounts.pagePermissions).toBe(1);
  });

  it('excludes page_permissions for non-exported users', async () => {
    // Add a page_permission for outsider user (not in migrated set)
    const { sql: sqlFn } = await import('drizzle-orm');
    await db.execute(sqlFn.raw(
      `INSERT INTO page_permissions (id, "pageId", "userId", "canView", "canEdit", "canShare", "canDelete", "grantedBy", "grantedAt")
       VALUES ('test_pp_outsider', '${FIXTURES.pages.root.id}', '${FIXTURES.users.outsider.id}', true, false, false, false, '${FIXTURES.users.owner.id}', NOW())`,
    ));

    const outputDir = path.join(tmpDir, 'bundle-fk-filter');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    // The outsider's page_permission should be excluded (userId is NOT NULL, can't nullify)
    // Only the original pp1 for FIXTURES.users.member should remain
    expect(result.manifest.tableCounts.pagePermissions).toBe(1);
    expect(result.sqlStatements).not.toContain(FIXTURES.users.outsider.id);
  });

  it('strips suspendedAt from exported users', async () => {
    // Simulate the migration read-only lock
    const { sql: sqlFn } = await import('drizzle-orm');
    await db.execute(sqlFn.raw(
      `UPDATE users SET "suspendedAt" = NOW(), "suspendedReason" = 'Migration in progress' WHERE id = '${FIXTURES.users.owner.id}'`,
    ));

    const outputDir = path.join(tmpDir, 'bundle-suspend');
    const result = await exportData(db as never, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    // The SQL should NOT contain 'Migration in progress'
    expect(result.sqlStatements).not.toContain('Migration in progress');
  });

  it('throws when no drives found for specified users', async () => {
    await expect(
      exportData(db as never, {
        userIds: ['nonexistent_user_id'],
        outputDir: path.join(tmpDir, 'empty'),
        fileStoragePath,
        databaseUrl: getTestDatabaseUrl(),
        dryRun: false,
      }),
    ).rejects.toThrow('No drives found');
  });
});

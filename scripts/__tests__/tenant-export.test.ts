/**
 * Integration tests for tenant-export.ts
 *
 * @integration - requires running postgres on port 5433
 *
 * Run: docker compose -f docker-compose.test.yml up -d && cd scripts && npx vitest run
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'fs/promises';
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
import type { ExportManifest, DbClient } from '../lib/migration-types';

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
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pagespace-export-test-'));
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
    const driveIds = await discoverDrives(db as unknown as DbClient, [
      FIXTURES.users.owner.id,
      FIXTURES.users.member.id,
    ]);

    expect(driveIds).toHaveLength(1);
    expect(driveIds).toContain(FIXTURES.drives.shared.id);
  });

  it('returns empty array for users with no drives', async () => {
    const driveIds = await discoverDrives(db as unknown as DbClient, ['nonexistent_user']);
    expect(driveIds).toHaveLength(0);
  });
});

describe('exportData', () => {
  it('exports correct users', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.messages).toBe(2);
  });

  it('exports files and copies blobs', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as unknown as DbClient, {
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

  it('exports page permissions', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as unknown as DbClient, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir,
      fileStoragePath,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    expect(result.manifest.tableCounts.pagePermissions).toBe(1);
  });

  it('exports tags and page-tag links', async () => {
    const outputDir = path.join(tmpDir, 'bundle');
    const result = await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
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
    await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
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
    const result = await exportData(db as unknown as DbClient, {
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
      exportData(db as unknown as DbClient, {
        userIds: ['nonexistent_user_id'],
        outputDir: path.join(tmpDir, 'empty'),
        fileStoragePath,
        databaseUrl: getTestDatabaseUrl(),
        dryRun: false,
      }),
    ).rejects.toThrow('No drives found');
  });

  /**
   * The bundle replays as ONE transaction, so its INSERT order has to be FK
   * order. `messages.conversationId` FKs `conversations.id`, and the two sets
   * are gathered along different axes — conversations by OWNER, pages by
   * DRIVE — so the exporter has to select conversations by PAGE as well, or a
   * page chat started by a drive member outside the export set arrives with no
   * parent row and the import aborts.
   */
  describe('conversation parent rows', () => {
    /** Reads the emitted bundle's statement order. */
    function insertPosition(sqlStatements: string, table: string): number {
      const at = sqlStatements.indexOf(`INSERT INTO "${table}"`);
      expect(at, `expected the bundle to contain an INSERT INTO "${table}"`).toBeGreaterThan(-1);
      return at;
    }

    it('emits conversations before the messages that reference them', async () => {
      const result = await exportData(db as unknown as DbClient, {
        userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
        outputDir: path.join(tmpDir, 'bundle-fk-order'),
        fileStoragePath,
        databaseUrl: getTestDatabaseUrl(),
        dryRun: false,
      });

      const conversationsAt = insertPosition(result.sqlStatements, 'conversations');
      expect(conversationsAt).toBeLessThan(insertPosition(result.sqlStatements, 'messages'));
    });

    it('exports the conversation behind an exported chat message even when its owner is not in the export set', async () => {
      // A page chat on an exported page, started by a drive member who is NOT
      // one of the requested users. The messages come along (they are selected
      // by page); without their parent row the bundle cannot be imported.
      const { sql: sqlFn } = await import('drizzle-orm');
      await db.execute(sqlFn.raw(
        `INSERT INTO conversations (id, "userId", title, type, "contextId", "createdAt", "updatedAt")
         VALUES ('test_convo_outsider_001', '${FIXTURES.users.outsider.id}', 'Outsider thread', 'page', '${FIXTURES.pages.grandchild.id}', NOW(), NOW())`,
      ));
      await db.execute(sqlFn.raw(
        `INSERT INTO messages (id, "conversationId", role, content, "userId", "createdAt")
         VALUES ('test_chatmsg_outsider_001', 'test_convo_outsider_001', 'user', 'Hi from outside the export set', '${FIXTURES.users.outsider.id}', NOW())`,
      ));

      const result = await exportData(db as unknown as DbClient, {
        userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
        outputDir: path.join(tmpDir, 'bundle-fk-orphan'),
        fileStoragePath,
        databaseUrl: getTestDatabaseUrl(),
        dryRun: false,
      });

      expect(result.manifest.tableCounts.messages).toBe(3);
      // Assert against the conversations statement specifically — the id also
      // appears in the message row, which is exactly the half that was never
      // in doubt.
      const conversationsInsert = result.sqlStatements.slice(
        insertPosition(result.sqlStatements, 'conversations'),
        insertPosition(result.sqlStatements, 'messages'),
      );
      expect(conversationsInsert).toContain('test_convo_outsider_001');
      // …and its owner is exported too, since conversations.userId is NOT NULL and FK'd.
      expect(result.sqlStatements).toContain(FIXTURES.users.outsider.id);
      expect(result.manifest.tableCounts.users).toBe(3);
    });

    it('exports agent-authored unified messages, whose userId is NULL since 0249', async () => {
      const { sql: sqlFn } = await import('drizzle-orm');
      await db.execute(sqlFn.raw(
        `INSERT INTO messages (id, "conversationId", "userId", role, content, "createdAt")
         VALUES ('test_msg_agent_001', '${FIXTURES.conversations.pageChat.id}', NULL, 'assistant', 'Agent-authored reply', NOW())`,
      ));

      const result = await exportData(db as unknown as DbClient, {
        userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
        outputDir: path.join(tmpDir, 'bundle-agent-msg'),
        fileStoragePath,
        databaseUrl: getTestDatabaseUrl(),
        dryRun: false,
      });

      // The two fixture rows plus this one — an agent reply carries no human
      // author, so an `IN (userIds)` filter alone would silently drop it.
      expect(result.manifest.tableCounts.messages).toBe(3);
      expect(result.sqlStatements).toContain('test_msg_agent_001');
    });
  });

  describe('path traversal protection', () => {
    async function seedTraversalFile(db: TestDb, storagePath: string, fileId: string): Promise<void> {
      const { sql: sqlFn } = await import('drizzle-orm');
      await db.execute(sqlFn.raw(
        `INSERT INTO files (id, "driveId", "sizeBytes", "mimeType", "storagePath", "createdBy", "createdAt", "updatedAt")
         VALUES ('${fileId}', '${FIXTURES.drives.shared.id}', 10, 'text/plain', '${storagePath}', '${FIXTURES.users.owner.id}', NOW(), NOW())`,
      ));
      await db.execute(sqlFn.raw(
        `INSERT INTO file_pages ("fileId", "pageId", "linkedBy", "linkedAt")
         VALUES ('${fileId}', '${FIXTURES.pages.root.id}', '${FIXTURES.users.owner.id}', NOW())`,
      ));
    }

    it('skips files with ../../etc/passwd traversal in storagePath', async () => {
      await seedTraversalFile(db, '../../etc/passwd', 'test_file_traversal_001');

      const outputDir = path.join(tmpDir, 'bundle-traversal-1');
      const result = await exportData(db as unknown as DbClient, {
        userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
        outputDir,
        fileStoragePath,
        databaseUrl: getTestDatabaseUrl(),
        dryRun: false,
      });

      // The traversal file should be skipped — only the legitimate file should be in checksums
      const traversalChecksum = result.manifest.fileChecksums.find(
        (c) => c.path === '../../etc/passwd',
      );
      expect(traversalChecksum).toBeUndefined();

      // The legitimate file should still be exported
      expect(result.manifest.fileChecksums).toHaveLength(1);
      expect(result.manifest.fileChecksums[0].path).toBe('test_file_blob_001/data.txt');
    });

    it('skips files with ../../../etc/shadow deep traversal', async () => {
      await seedTraversalFile(db, '../../../etc/shadow', 'test_file_traversal_002');

      const outputDir = path.join(tmpDir, 'bundle-traversal-2');
      const result = await exportData(db as unknown as DbClient, {
        userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
        outputDir,
        fileStoragePath,
        databaseUrl: getTestDatabaseUrl(),
        dryRun: false,
      });

      const traversalChecksum = result.manifest.fileChecksums.find(
        (c) => c.path === '../../../etc/shadow',
      );
      expect(traversalChecksum).toBeUndefined();
      expect(result.manifest.fileChecksums).toHaveLength(1);
    });
  });
});

/**
 * Integration tests for tenant-import.ts
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
import { runImport } from '../tenant-import';
import { validateChecksums } from '../lib/migration-utils';
import { TENANT_EXPORT_EXCLUDED_TABLES } from '../lib/tenant-export-columns';
import type { DbClient, ExportManifest } from '../lib/migration-types';

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
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pagespace-import-test-'));
  fileStoragePath = path.join(tmpDir, 'source-files');
  bundleDir = path.join(tmpDir, 'bundle');
  await mkdir(fileStoragePath, { recursive: true });

  // Create the test file blob on disk
  const blobDir = path.join(fileStoragePath, 'test_file_blob_001');
  await mkdir(blobDir, { recursive: true });
  await writeFile(path.join(blobDir, 'data.txt'), '0123456789');

  // Export a bundle we can import
  await exportData(db as unknown as DbClient, {
    userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
    outputDir: bundleDir,
    fileStoragePath,
    databaseUrl: getTestDatabaseUrl(),
    dryRun: false,
  });
});

afterEach(async () => {
  if (tmpDir && existsSync(tmpDir)) {
    await rm(tmpDir, { recursive: true, force: true });
  }
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

  /**
   * Round-trip proof for the columns the hand-maintained export lists used to
   * drop silently. Every value asserted here is seeded AWAY from its column
   * default (see `seedFixtures`), so a passing assertion means the value
   * travelled — not that the tenant's default happened to agree.
   *
   * The drift guard (`tenant-export-columns.test.ts`) keeps the LIST honest
   * against the schema; this keeps the bundle honest against a real database.
   */
  describe('carries every column through a full round trip', () => {
    async function reimport(label: string): Promise<void> {
      await truncateAll(db);
      const targetFilePath = path.join(tmpDir, `target-files-${label}`);
      await mkdir(targetFilePath, { recursive: true });
      await runImport({
        bundleDir,
        databaseUrl: getTestDatabaseUrl(),
        fileStoragePath: targetFilePath,
        dryRun: false,
      });
    }

    it('restores the conversation⇄session binding, rev, closed-listing stamp and shared flag', async () => {
      await reimport('conversation');

      const rows = (await db.execute(sql.raw(
        `SELECT "workspaceId", rev, "closedInWorkspaceAt", "isShared" FROM conversations WHERE id = '${FIXTURES.conversations.pageChat.id}'`,
      ))).rows as Record<string, unknown>[];

      expect(rows).toHaveLength(1);
      expect(rows[0].workspaceId).toBe(FIXTURES.agentWorkspaces.workspace.id);
      expect(Number(rows[0].rev)).toBe(FIXTURES.conversations.pageChat.rev);
      expect(rows[0].closedInWorkspaceAt).not.toBeNull();
      expect(rows[0].isShared).toBe(true);
    });

    it('carries the agent session the conversation is bound to, without its source-fleet Sprite identity', async () => {
      await reimport('session');

      const rows = (await db.execute(sql.raw(
        `SELECT "driveId", "ownerId", name, "sandboxId", "spriteInstanceId", "spriteKey", "storageMeasuredBytes" FROM agent_workspaces WHERE id = '${FIXTURES.agentWorkspaces.workspace.id}'`,
      ))).rows as Record<string, unknown>[];

      expect(rows).toHaveLength(1);
      expect(rows[0].driveId).toBe(FIXTURES.drives.shared.id);
      expect(rows[0].ownerId).toBe(FIXTURES.users.owner.id);
      expect(rows[0].name).toBe(FIXTURES.agentWorkspaces.workspace.name);
      // The exclusion allowlist in scripts/lib/tenant-export-columns.ts: these
      // name a VM in the SOURCE fleet and must NOT reach the tenant, which
      // provisions its own on first use.
      expect(rows[0].sandboxId).toBeNull();
      expect(rows[0].spriteInstanceId).toBeNull();
      expect(rows[0].spriteKey).toBeNull();
      expect(rows[0].storageMeasuredBytes).toBeNull();
    });

    it("carries the session's terminal AND its scrollback, without the source-fleet exec id", async () => {
      await reimport('shell');

      const rows = (await db.execute(sql.raw(
        `SELECT "workspaceId", "ownerId", name, "agentType", command, "coldTail", "coldTailAt", "coldTailHasOutput", "spriteExecId" FROM agent_workspace_shells WHERE id = '${FIXTURES.agentWorkspaceShells.shell.id}'`,
      ))).rows as Record<string, unknown>[];

      expect(rows).toHaveLength(1);
      expect(rows[0].workspaceId).toBe(FIXTURES.agentWorkspaces.workspace.id);
      expect(rows[0].ownerId).toBe(FIXTURES.users.owner.id);
      expect(rows[0].name).toBe(FIXTURES.agentWorkspaceShells.shell.name);
      expect(rows[0].agentType).toBe(FIXTURES.agentWorkspaceShells.shell.agentType);
      expect(rows[0].command).toBe(FIXTURES.agentWorkspaceShells.shell.command);
      // THE POINT OF CARRYING THIS TABLE. `coldTail` is the scrollback of the
      // shell's last dead incarnation — overwritten in place on every teardown
      // and present nowhere else in the bundle, so if it does not survive the
      // round trip it is gone for good. `coldTailHasOutput` travels with it
      // because an empty tail is ambiguous alone (a burst larger than the ring
      // also empties it), and "was screaming" must not migrate as "was silent".
      expect(rows[0].coldTail).toBe(FIXTURES.agentWorkspaceShells.shell.coldTail);
      expect(rows[0].coldTailHasOutput).toBe(true);
      expect(rows[0].coldTailAt).not.toBeNull();
      // Same rule as the parent session's Sprite columns: this names an exec
      // session inside a SOURCE-fleet VM the tenant does not own.
      expect(rows[0].spriteExecId).toBeNull();
    });

    it('leaves ai_stream_sessions behind — a deliberate exclusion, not an omission', async () => {
      // The Art 17 purge and the Art 15 export both reach this table (see
      // `packages/lib/src/compliance/export/gdpr-export-coverage.ts`); the
      // TENANT bundle deliberately does not, because a `status = streaming`
      // row would import as a phantom live stream in an instance that has no
      // worker producing it and no abort registry that can reach it. The
      // durable half of the turn is in `messages`, which the bundle carries.
      //
      // Asserted as an absence FROM A BUNDLE THAT WAS ASKED FOR EVERYTHING, so
      // this fails the moment someone adds the table to TABLE_IMPORT_ORDER
      // without also deleting the recorded exclusion.
      expect(TENANT_EXPORT_EXCLUDED_TABLES).toHaveProperty('ai_stream_sessions');
      const sqlContent = await readFile(path.join(bundleDir, 'data.sql'), 'utf-8');
      expect(sqlContent).not.toContain('ai_stream_sessions');
      // …and the conversation whose rows they would have been is present, so
      // the absence above is a decision about this table rather than an empty
      // bundle trivially satisfying it.
      expect(sqlContent).toContain(FIXTURES.conversations.pageChat.id);
    });

    it("restores the user's email blind index — the lookup key a migrated account logs in through", async () => {
      await reimport('user');

      const rows = (await db.execute(sql.raw(
        `SELECT "emailBidx" FROM users WHERE id = '${FIXTURES.users.owner.id}'`,
      ))).rows as Record<string, unknown>[];

      expect(rows[0].emailBidx).toBe(FIXTURES.users.owner.emailBidx);
    });

    it("restores the drive's landing page, which FKs forward and rides a trailing UPDATE", async () => {
      await reimport('drive');

      const rows = (await db.execute(sql.raw(
        `SELECT "homePageId" FROM drives WHERE id = '${FIXTURES.drives.shared.id}'`,
      ))).rows as Record<string, unknown>[];

      expect(rows[0].homePageId).toBe(FIXTURES.pages.root.id);
    });

    it("restores the pages' agent settings, privacy flag, description and author", async () => {
      await reimport('pages');

      const rows = (await db.execute(sql.raw(
        `SELECT id, description, "isPrivate", "createdBy", "toolExposureMode", "sandboxEnabled", "userScopedAccess" FROM pages WHERE "driveId" = '${FIXTURES.drives.shared.id}'`,
      ))).rows as Record<string, unknown>[];
      const byId = new Map(rows.map((r) => [r.id as string, r]));

      const root = byId.get(FIXTURES.pages.root.id)!;
      expect(root.description).toBe(FIXTURES.pages.root.description);
      expect(root.isPrivate).toBe(true);
      expect(root.createdBy).toBe(FIXTURES.users.owner.id);

      const agent = byId.get(FIXTURES.pages.grandchild.id)!;
      expect(agent.toolExposureMode).toBe('search');
      expect(agent.sandboxEnabled).toBe(true);
      expect(agent.userScopedAccess).toBe(true);
    });

    it('carries the unified messages\' agent attribution', async () => {
      // A conversation-scoped agent reply: NULL userId + a sourceAgentId, the
      // exact shape the attribution rule describes. There is no per-row page
      // column any more — a message's page is its conversation's.
      await db.execute(sql`
        INSERT INTO messages (id, "conversationId", "userId", role, content, "sourceAgentId", "createdAt")
        VALUES ('test_message_attrib_001', ${FIXTURES.conversations.pageChat.id}, NULL, 'assistant', 'Agent reply', ${FIXTURES.pages.grandchild.id}, ${new Date()})
      `);
      await exportData(db as unknown as DbClient, {
        userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
        outputDir: bundleDir,
        fileStoragePath,
        databaseUrl: getTestDatabaseUrl(),
        dryRun: false,
      });

      await reimport('messages');

      const rows = (await db.execute(sql.raw(
        `SELECT "userId", "sourceAgentId" FROM messages WHERE id = 'test_message_attrib_001'`,
      ))).rows as Record<string, unknown>[];

      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBeNull();
      expect(rows[0].sourceAgentId).toBe(FIXTURES.pages.grandchild.id);
    });

    it('carries a type=client thread\'s agent page link', async () => {
      // The `type='client'` page link Phase 4 PR 15 introduced. It is the ONLY
      // thing naming an API thread's agent page now that `messages."pageId"`
      // is gone, so a migration that dropped it would 404 that thread's own
      // edit/delete route in the tenant.
      await db.execute(sql`
        INSERT INTO conversations (id, "userId", title, type, "contextId", "agentPageId", "createdAt", "updatedAt")
        VALUES ('test_convo_client_001', ${FIXTURES.users.owner.id}, 'API thread', 'client', ${FIXTURES.drives.shared.id}, ${FIXTURES.pages.grandchild.id}, ${new Date()}, ${new Date()})
      `);
      await exportData(db as unknown as DbClient, {
        userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
        outputDir: bundleDir,
        fileStoragePath,
        databaseUrl: getTestDatabaseUrl(),
        dryRun: false,
      });

      await reimport('conversations');

      const rows = (await db.execute(sql.raw(
        `SELECT "contextId", "agentPageId" FROM conversations WHERE id = 'test_convo_client_001'`,
      ))).rows as Record<string, unknown>[];

      expect(rows).toHaveLength(1);
      // `contextId` stays the DRIVE — it is what a drive-scoped MCP token is
      // authorized against — and the page rides its own column.
      expect(rows[0].contextId).toBe(FIXTURES.drives.shared.id);
      expect(rows[0].agentPageId).toBe(FIXTURES.pages.grandchild.id);
    });
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

  it('round-trips page content with semicolons and SQL-like comments', async () => {
    const contentWithSemicolons = 'const x = 1;\n-- SQL comment\nconst y = 2;';

    await db.execute(sql.raw(
      `UPDATE pages SET content = '${contentWithSemicolons.replace(/'/g, "''")}' WHERE id = '${FIXTURES.pages.root.id}'`,
    ));

    // Re-export with the new content
    const semiBundle = path.join(tmpDir, 'semicolon-bundle');
    const srcFiles = path.join(tmpDir, 'src-files-semi');
    await mkdir(srcFiles, { recursive: true });

    await exportData(db as unknown as DbClient, {
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      outputDir: semiBundle,
      fileStoragePath: srcFiles,
      databaseUrl: getTestDatabaseUrl(),
      dryRun: false,
    });

    // Truncate and reimport
    await truncateAll(db);
    const tgtFiles = path.join(tmpDir, 'tgt-files-semi');
    await mkdir(tgtFiles, { recursive: true });

    await runImport({
      bundleDir: semiBundle,
      databaseUrl: getTestDatabaseUrl(),
      fileStoragePath: tgtFiles,
      dryRun: false,
    });

    // Verify content survived the round-trip
    const result = await db.execute(sql.raw(
      `SELECT content FROM pages WHERE id = '${FIXTURES.pages.root.id}'`,
    ));
    const rows = result.rows as Record<string, unknown>[];
    expect(rows[0].content).toBe(contentWithSemicolons);
  });

  it('flags path traversal in manifest checksums as INVALID_PATH', async () => {
    // Given: a manifest with a traversal path in fileChecksums
    // Should: report the traversal entry as INVALID_PATH mismatch
    const manifestRaw = await readFile(path.join(bundleDir, 'manifest.json'), 'utf-8');
    const manifest: ExportManifest = JSON.parse(manifestRaw);

    manifest.fileChecksums.push({
      path: '../../etc/passwd',
      sha256: 'aaaa',
      sizeBytes: 100,
    });

    const mismatches = await validateChecksums(bundleDir, manifest);

    const traversalMismatch = mismatches.find((m) => m.path === '../../etc/passwd');
    expect(traversalMismatch).toBeDefined();
    expect(traversalMismatch!.actual).toBe('INVALID_PATH');
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
INSERT INTO "users" ("id", "name", "email", "provider", "createdAt", "updatedAt")
VALUES ('test1', 'Test', 'test@test.com', 'email', NOW(), NOW())
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

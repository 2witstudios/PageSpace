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

    // The tag vocabulary travels by DRIVE — BOTH entries, including the one with
    // no assignment. Deriving the list from the surviving assignments instead
    // would carry only `important` and lose `unused` in silence, which is
    // exactly what this asserts cannot happen.
    const tagsResult = await db.execute(sql.raw(
      `SELECT id FROM tags WHERE "driveId" = '${FIXTURES.drives.shared.id}' ORDER BY id`,
    ));
    expect(tagsResult.rows.map((r) => (r as { id: string }).id)).toEqual([
      FIXTURES.tags.tag1.id,
      FIXTURES.tags.unusedTag.id,
    ]);

    // And the ASSIGNMENT survives the round trip. Worth pinning separately from
    // "the import did not throw": `content_tags` carries real FKs onto
    // `channel_messages` and `messages`, so a selection rule that exported a row
    // whose message stayed behind would abort the whole bundle here — see
    // `contentTagSelectionWhere`, which both the exporter and the validator use
    // so neither can ask a different question than the other answered.
    const contentTagsResult = await db.execute(sql.raw(
      `SELECT id, "tagId", "pageId", "targetKind" FROM content_tags`,
    ));
    expect(contentTagsResult.rows).toHaveLength(1);
    expect(contentTagsResult.rows[0]).toMatchObject({
      id: FIXTURES.contentTags.ct1.id,
      tagId: FIXTURES.tags.tag1.id,
      pageId: FIXTURES.pages.root.id,
      targetKind: 'page',
    });
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

    it('restores the conversation rev and shared flag', async () => {
      await reimport('conversation');

      const rows = (await db.execute(sql.raw(
        `SELECT rev, "isShared" FROM conversations WHERE id = '${FIXTURES.conversations.pageChat.id}'`,
      ))).rows as Record<string, unknown>[];

      expect(rows).toHaveLength(1);
      expect(Number(rows[0].rev)).toBe(FIXTURES.conversations.pageChat.rev);
      expect(rows[0].isShared).toBe(true);
      // The conversation⇄session BINDING used to be asserted here, off
      // `conversations."workspaceId"` and `"closedInWorkspaceAt"`. Both columns
      // are dropped — a thread's workspace is an `agent_workspace_nodes` row —
      // so the assertion moved to the test below rather than disappearing.
    });

    /**
     * MEMBERSHIP SURVIVES THE ROUND TRIP. This is the assertion that used to
     * live on `conversations."workspaceId"`: after the import, the thread is in
     * the workspace, and it is in it because a chat-bound node says so. Without
     * this the tenant's sessions open empty and the threads are reachable only
     * through past-conversation history.
     */
    it('restores the thread\'s membership in its session, and the tree that holds it', async () => {
      await reimport('nodes');

      const rows = (await db.execute(sql.raw(
        `SELECT id, "parentId", position, "nodeType", axis, "targetKind", "targetId"`
        + ` FROM agent_workspace_nodes WHERE "rootId" = '${FIXTURES.agentWorkspaces.workspace.id}' ORDER BY id`,
      ))).rows as Record<string, unknown>[];
      const byId = new Map(rows.map((r) => [r.id as string, r]));

      expect(rows).toHaveLength(2);

      const root = byId.get('test_agent_node_root_001')!;
      expect(root.nodeType).toBe('root');
      expect(root.parentId).toBeNull();
      expect(root.axis).toBe('row');

      // THE BINDING. Both halves of the pair, since either alone is a corrupt
      // pane the tenant's row parse refuses.
      const pane = byId.get('test_agent_node_pane_001')!;
      expect(pane.nodeType).toBe('pane');
      expect(pane.parentId).toBe('test_agent_node_root_001');
      expect(pane.targetKind).toBe('chat');
      expect(pane.targetId).toBe(FIXTURES.conversations.pageChat.id);
    });

    /**
     * …and the counter beside it does NOT travel, which is the other half of
     * the decision. `rev` is issued by the source database and held by clients
     * as `baseRev`; the tenant's read COALESCEs a missing row to 0 and its
     * first write mints 1.
     */
    it('leaves the node rev behind, and the workspace still reads as its tree at rev 0', async () => {
      await reimport('node-revs');

      const revs = (await db.execute(sql.raw(
        `SELECT count(*) AS count FROM agent_workspace_node_revs`,
      ))).rows as Record<string, unknown>[];
      expect(Number(revs[0].count)).toBe(0);

      // The nodes are there regardless — "no rev row" is not "no workspace".
      const nodes = (await db.execute(sql.raw(
        `SELECT count(*) AS count FROM agent_workspace_nodes WHERE "rootId" = '${FIXTURES.agentWorkspaces.workspace.id}'`,
      ))).rows as Record<string, unknown>[];
      expect(Number(nodes[0].count)).toBe(2);
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
      // Its successor travels with it. `ai_stream_frames` holds the same generation's
      // content in the form that replaces `parts`, so importing it would reconstitute
      // exactly the phantom this exclusion exists to prevent — and its `message_id`
      // names an assistant placeholder written best-effort, which the bundle may not
      // carry a row for at all.
      expect(TENANT_EXPORT_EXCLUDED_TABLES).toHaveProperty('ai_stream_frames');
      const sqlContent = await readFile(path.join(bundleDir, 'data.sql'), 'utf-8');
      expect(sqlContent).not.toContain('ai_stream_sessions');
      expect(sqlContent).not.toContain('ai_stream_frames');
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

    // The nodes INSERT arbitrates on its PRIMARY KEY rather than on every
    // unique index (see the chat-collision block below), and this is the half
    // of that narrowing which must NOT change: re-inserting a row identical to
    // one already there is still a silent no-op, because Postgres consults the
    // arbiter index first and never speculatively inserts. Were it otherwise,
    // the row's own chat binding would collide with itself and every re-import
    // of an already-imported bundle would abort.
    const nodesResult = await db.execute(sql.raw(`SELECT count(*) as count FROM agent_workspace_nodes`));
    expect(Number((nodesResult.rows as Record<string, unknown>[])[0].count)).toBe(2);
  });

  /**
   * A CHAT-INDEX COLLISION FAILS THE BUNDLE, LOUDLY.
   *
   * `UNIQUE (targetId) WHERE targetKind = 'chat'` is GLOBAL — a conversation is
   * bound to at most one node anywhere — so a destination that already holds
   * one of the incoming threads cannot take the incoming node too. The bundle's
   * usual untargeted `ON CONFLICT DO NOTHING` would forgive that violation like
   * any other and SKIP the row: a successful-looking import with a thread
   * missing from the workspace it belongs to, discovered months later by the
   * user who lost it. The nodes INSERT names its primary key as the conflict
   * target instead, so only "already imported" is forgiven and this raises,
   * aborting the single transaction the whole bundle replays in.
   */
  describe('a conversation already bound in the destination', () => {
    const DEST_WORKSPACE = 'test_agent_session_dest_001';
    const DEST_ROOT = 'test_agent_node_dest_root';
    const DEST_PANE = 'test_agent_node_dest_pane';

    beforeEach(async () => {
      // The bundle was exported in the outer beforeEach. Now make the
      // destination hold the SAME thread under a different session — the state
      // two databases that were never one arrive in.
      await truncateAll(db);
      await seedFixtures(db);
      await db.execute(sql.raw(
        `DELETE FROM agent_workspace_nodes WHERE "rootId" = '${FIXTURES.agentWorkspaces.workspace.id}'`,
      ));
      await db.execute(sql.raw(
        `DELETE FROM agent_workspaces WHERE id = '${FIXTURES.agentWorkspaces.workspace.id}'`,
      ));
      await db.execute(sql.raw(
        `INSERT INTO agent_workspaces (id, "driveId", "ownerId", name, "createdAt", "updatedAt")`
        + ` VALUES ('${DEST_WORKSPACE}', '${FIXTURES.drives.shared.id}', '${FIXTURES.users.owner.id}', 'Tenant session', NOW(), NOW())`,
      ));
      await db.execute(sql.raw(
        `INSERT INTO agent_workspace_nodes (id, "rootId", "parentId", position, "nodeType", axis, "createdAt", "updatedAt")`
        + ` VALUES ('${DEST_ROOT}', '${DEST_WORKSPACE}', NULL, 0, 'root', 'row', NOW(), NOW())`,
      ));
      await db.execute(sql.raw(
        `INSERT INTO agent_workspace_nodes (id, "rootId", "parentId", position, "nodeType", "targetKind", "targetId", "createdAt", "updatedAt")`
        + ` VALUES ('${DEST_PANE}', '${DEST_WORKSPACE}', '${DEST_ROOT}', 0, 'pane', 'chat', '${FIXTURES.conversations.pageChat.id}', NOW(), NOW())`,
      ));
    });

    it('fails the import and names the constraint, rather than dropping the node', async () => {
      await expect(
        runImport({
          bundleDir,
          databaseUrl: getTestDatabaseUrl(),
          fileStoragePath: path.join(tmpDir, 'target-chat-collision'),
          dryRun: false,
        }),
      ).rejects.toThrow('agent_workspace_nodes_chat_target_idx');
    });

    it('lands nothing at all — the collision aborts the whole bundle', async () => {
      await runImport({
        bundleDir,
        databaseUrl: getTestDatabaseUrl(),
        fileStoragePath: path.join(tmpDir, 'target-chat-collision-2'),
        dryRun: false,
      }).catch(() => {});

      // The destination's own binding is intact…
      const dest = (await db.execute(sql.raw(
        `SELECT "rootId" FROM agent_workspace_nodes WHERE "targetKind" = 'chat' AND "targetId" = '${FIXTURES.conversations.pageChat.id}'`,
      ))).rows as Record<string, unknown>[];
      expect(dest).toHaveLength(1);
      expect(dest[0].rootId).toBe(DEST_WORKSPACE);

      // …and the incoming session did not half-land beside it.
      const incoming = (await db.execute(sql.raw(
        `SELECT id FROM agent_workspaces WHERE id = '${FIXTURES.agentWorkspaces.workspace.id}'`,
      ))).rows as Record<string, unknown>[];
      expect(incoming).toHaveLength(0);
    });
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

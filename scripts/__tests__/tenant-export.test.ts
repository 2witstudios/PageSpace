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

  /**
   * MEMBERSHIP — `agent_workspace_nodes`. A thread is in a workspace exactly
   * when a chat-bound node of that workspace names it, which is the fact
   * `conversations."workspaceId"` used to carry. Migration 0256 dropped that
   * column, so if these rows do not travel the tenant opens every session empty
   * and every thread is reachable only through past-conversation history.
   *
   * The one thing that makes this more than a query is `targetId`: it is
   * polymorphic with NO foreign key, so a pane can name a conversation, a shell
   * or a page that the bundle does not carry, and the exporter's referential
   * rules cannot see it. The block below drives all three kinds.
   */
  describe('workspace membership (agent_workspace_nodes)', () => {
    const ROOT_NODE = 'test_agent_node_root_001';
    const CHAT_PANE = 'test_agent_node_pane_001';
    const WORKSPACE = FIXTURES.agentWorkspaces.workspace.id;

    /** The one INSERT statement for `table`, from its header to its terminator. */
    function insertFor(sqlStatements: string, table: string): string {
      const at = sqlStatements.indexOf(`INSERT INTO "${table}"`);
      expect(at, `expected the bundle to contain an INSERT INTO "${table}"`).toBeGreaterThan(-1);
      const end = sqlStatements.indexOf('DO NOTHING;', at);
      expect(end, `unterminated INSERT INTO "${table}"`).toBeGreaterThan(-1);
      return sqlStatements.slice(at, end + 'DO NOTHING;'.length);
    }

    /** Adds a pane under the fixture workspace's root, bound to `kind`/`targetId`. */
    async function seedPane(
      id: string,
      position: number,
      kind: string | null,
      targetId: string | null,
    ): Promise<void> {
      await db.execute(sql`
        INSERT INTO agent_workspace_nodes (id, "rootId", "parentId", position, "nodeType", "targetKind", "targetId", "createdAt", "updatedAt")
        VALUES (${id}, ${WORKSPACE}, ${ROOT_NODE}, ${position}, 'pane', ${kind}, ${targetId}, ${new Date()}, ${new Date()})
      `);
    }

    const exportBundle = (label: string) =>
      exportData(db as unknown as DbClient, {
        userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
        outputDir: path.join(tmpDir, `bundle-${label}`),
        fileStoragePath,
        databaseUrl: getTestDatabaseUrl(),
        dryRun: false,
      });

    it('carries the session tree that binds the thread to the workspace', async () => {
      const result = await exportBundle('nodes');

      expect(result.manifest.tableCounts.agentWorkspaceNodes).toBe(2);

      const nodes = insertFor(result.sqlStatements, 'agent_workspace_nodes');
      expect(nodes).toContain(ROOT_NODE);
      expect(nodes).toContain(CHAT_PANE);
      // The binding itself — the thing a bundle without this table loses.
      expect(nodes).toContain(FIXTURES.conversations.pageChat.id);
      expect(nodes).toContain(WORKSPACE);
    });

    /**
     * The composite self-FK is `(rootId, parentId) → (rootId, id)`, so a node's
     * parent is always in its own workspace and the `rootId`-scoped query takes
     * every one of them. Nothing downstream filters rows — the unbinding
     * rewrites two columns and drops nothing — so a tree travels whole or not
     * at all. Pinned with a SPLIT holding two panes, the shape a filter that
     * reasoned about targets rather than about `rootId` would break: the split
     * itself binds nothing.
     */
    it('carries a whole tree, including the container nodes that bind no target', async () => {
      await db.execute(sql`
        INSERT INTO agent_workspace_nodes (id, "rootId", "parentId", position, "nodeType", axis, "createdAt", "updatedAt")
        VALUES ('test_agent_node_split_001', ${WORKSPACE}, ${ROOT_NODE}, 1, 'split', 'column', ${new Date()}, ${new Date()})
      `);
      await db.execute(sql`
        INSERT INTO agent_workspace_nodes (id, "rootId", "parentId", position, "nodeType", "targetKind", "targetId", "createdAt", "updatedAt")
        VALUES ('test_agent_node_split_kid_a', ${WORKSPACE}, 'test_agent_node_split_001', 0, 'pane', 'page', ${FIXTURES.pages.root.id}, ${new Date()}, ${new Date()})
      `);
      await db.execute(sql`
        INSERT INTO agent_workspace_nodes (id, "rootId", "parentId", position, "nodeType", "targetKind", "targetId", "createdAt", "updatedAt")
        VALUES ('test_agent_node_split_kid_b', ${WORKSPACE}, 'test_agent_node_split_001', 1, 'pane', 'page', ${FIXTURES.pages.child.id}, ${new Date()}, ${new Date()})
      `);

      const result = await exportBundle('nodes-tree');

      expect(result.manifest.tableCounts.agentWorkspaceNodes).toBe(5);
      const nodes = insertFor(result.sqlStatements, 'agent_workspace_nodes');
      for (const id of [
        ROOT_NODE, CHAT_PANE,
        'test_agent_node_split_001',
        'test_agent_node_split_kid_a',
        'test_agent_node_split_kid_b',
      ]) {
        expect(nodes, `node ${id} left its workspace behind`).toContain(id);
      }
    });

    /**
     * UNBOUND, NOT PRUNED, for all three kinds. Dropping the row would leave the
     * parent split with one child — `validateTree`'s `degenerate_split` — and
     * `nodesFromRows` rejects the whole set rather than the bad row, so the
     * tenant would refuse to open the workspace at all. A NULL pair is a state
     * the model spells natively: a pane rendering the target picker.
     */
    describe('unbinds a pane whose target does not travel', () => {
      /** The `targetKind`/`targetId` a node arrived at, read back out of the bundle. */
      function bindingOf(sqlStatements: string, nodeId: string): string {
        const nodes = insertFor(sqlStatements, 'agent_workspace_nodes');
        const row = nodes.split('\n').find((line) => line.includes(`'${nodeId}'`));
        expect(row, `node ${nodeId} is not in the bundle`).toBeDefined();
        return row!;
      }

      it("nulls both columns for a conversation the bundle does not carry", async () => {
        // Eve's own global thread: not owned by a requested user and on no
        // exported page, so it stays behind — while a pane in the exported
        // workspace names it. The schema's own note says this is reachable
        // ("a pane naming a conversation in another session is reachable").
        await db.execute(sql`
          INSERT INTO conversations (id, "userId", title, type, "contextId", "createdAt", "updatedAt")
          VALUES ('test_convo_left_behind_001', ${FIXTURES.users.outsider.id}, 'Eve global thread', 'global', NULL, ${new Date()}, ${new Date()})
        `);
        await seedPane('test_agent_node_pane_chat_out', 1, 'chat', 'test_convo_left_behind_001');

        const result = await exportBundle('nodes-chat-out');

        // The node travels; the binding does not.
        const row = bindingOf(result.sqlStatements, 'test_agent_node_pane_chat_out');
        expect(row).not.toContain('test_convo_left_behind_001');
        expect(row).not.toContain("'chat'");
        // …and the conversation is nowhere in the bundle, so the absence above
        // is the exporter's decision rather than a row that never existed.
        expect(result.sqlStatements).not.toContain('test_convo_left_behind_001');
        // The IN-BUNDLE chat pane beside it keeps its binding — the rule is
        // "outside the bundle", not "chat panes are unbound".
        expect(bindingOf(result.sqlStatements, CHAT_PANE))
          .toContain(FIXTURES.conversations.pageChat.id);
      });

      it('nulls both columns for a terminal whose shell does not travel', async () => {
        // A shell in the exported session but owned by a user outside the
        // migration: `agentShellsData` filters it out (both its FKs are NOT
        // NULL, so there is no orphan-and-carry shape for it).
        await db.execute(sql`
          INSERT INTO agent_workspace_shells (id, "workspaceId", "ownerId", name, "agentType", "createdAt", "updatedAt")
          VALUES ('test_agent_shell_outsider', ${WORKSPACE}, ${FIXTURES.users.outsider.id}, 'eve', 'shell', ${new Date()}, ${new Date()})
        `);
        await seedPane('test_agent_node_pane_term_out', 2, 'terminal', 'test_agent_shell_outsider');
        await seedPane('test_agent_node_pane_term_in', 3, 'terminal', FIXTURES.agentWorkspaceShells.shell.id);

        const result = await exportBundle('nodes-term-out');

        const unbound = bindingOf(result.sqlStatements, 'test_agent_node_pane_term_out');
        expect(unbound).not.toContain('test_agent_shell_outsider');
        // The KIND goes with the id — half a binding is a corrupt pane.
        expect(unbound).not.toContain("'terminal'");
        // The shell that DID travel keeps its pane bound to it.
        expect(bindingOf(result.sqlStatements, 'test_agent_node_pane_term_in'))
          .toContain(FIXTURES.agentWorkspaceShells.shell.id);
      });

      it('nulls both columns for a page in a drive this migration does not carry', async () => {
        // A plan or document open in a pane can legitimately live in another
        // drive — the same motive `conversations.planPageId` is nulled for.
        await db.execute(sql`
          INSERT INTO drives (id, name, slug, "ownerId", "createdAt", "updatedAt")
          VALUES ('test_drive_other_001', 'Eve drive', 'eve-drive', ${FIXTURES.users.outsider.id}, ${new Date()}, ${new Date()})
        `);
        await db.execute(sql`
          INSERT INTO pages (id, title, type, content, position, "driveId", "createdBy", "createdAt", "updatedAt")
          VALUES ('test_page_other_drive_001', 'Eve doc', 'DOCUMENT', '', 0, 'test_drive_other_001', ${FIXTURES.users.outsider.id}, ${new Date()}, ${new Date()})
        `);
        await seedPane('test_agent_node_pane_page_out', 4, 'page', 'test_page_other_drive_001');
        await seedPane('test_agent_node_pane_page_in', 5, 'page', FIXTURES.pages.root.id);

        const result = await exportBundle('nodes-page-out');

        const unbound = bindingOf(result.sqlStatements, 'test_agent_node_pane_page_out');
        expect(unbound).not.toContain('test_page_other_drive_001');
        expect(unbound).not.toContain("'page'");
        expect(bindingOf(result.sqlStatements, 'test_agent_node_pane_page_in'))
          .toContain(FIXTURES.pages.root.id);
      });

      it('clears a half-bound row rather than carrying a pane the tenant cannot parse', async () => {
        // No CHECK forbids this pair in the database, and the row parse refuses
        // it ("a pane target needs both a kind and an id, or neither") — and
        // refuses the whole workspace with it.
        await seedPane('test_agent_node_pane_half', 6, 'chat', null);

        const result = await exportBundle('nodes-half');

        expect(bindingOf(result.sqlStatements, 'test_agent_node_pane_half'))
          .not.toContain("'chat'");
      });
    });

    /**
     * The chat index is GLOBAL — `UNIQUE (targetId) WHERE targetKind = 'chat'`
     * — so an incoming node can collide with a binding the destination already
     * holds. Untargeted `ON CONFLICT DO NOTHING` forgives every unique
     * violation, which would SKIP that node in silence: a successful import
     * with a thread missing from the workspace it belongs to. Naming the
     * primary key forgives only "this bundle was already imported"; anything
     * else raises and takes the whole single-transaction bundle with it.
     */
    it('forgives only a primary-key conflict on the nodes INSERT', async () => {
      const result = await exportBundle('nodes-conflict');
      const nodes = insertFor(result.sqlStatements, 'agent_workspace_nodes');

      expect(nodes).toContain('ON CONFLICT ("rootId", "id") DO NOTHING;');
      // Every other table keeps the blanket form — the narrowing is this
      // table's, not a change of house style.
      expect(insertFor(result.sqlStatements, 'users')).toContain('ON CONFLICT DO NOTHING;');
    });

    it('leaves agent_workspace_node_revs behind', async () => {
      const result = await exportBundle('nodes-revs');
      // A per-workspace counter issued by the SOURCE database; the tenant's
      // read COALESCEs a missing row to rev 0 and its first write mints 1.
      // See the recorded exclusion in lib/tenant-export-columns.ts.
      expect(result.sqlStatements).not.toContain('agent_workspace_node_revs');
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

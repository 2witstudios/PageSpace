/**
 * Integration tests for tenant-validate.ts
 *
 * @integration - requires running postgres on port 5433
 *
 * Run: docker compose -f docker-compose.test.yml up -d && cd scripts && npx vitest run
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm, symlink, chmod } from 'fs/promises';
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
import { validateData, resolveSourceStorageRoot, isSameStorageRoot } from '../tenant-validate';
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

/**
 * HARNESS LIMITATION, stated once because three separate comments were arguing
 * about it.
 *
 * Every case in this file passes the SAME `db` handle as source and target, and
 * mostly the same storage path. `validateTable` runs one query object against
 * both, so `missingIds`/`extraIds` are always empty: a table's `passed`, and
 * therefore `result.passed`, is true for ANY predicate. Those assertions
 * document intent; they cannot fail, and they must not be read as evidence that
 * a predicate is right.
 *
 * `sourceCount` is the load-bearing assertion. It is a measurement of the
 * SOURCE population, which is exactly where every exporter/validator asymmetry
 * this file guards has lived. The file-blob comparison is the one check that
 * can genuinely differ, and only when a case passes two different paths.
 */
describe('resolveSourceStorageRoot', () => {
  /**
   * `FILE_STORAGE_PATH` is deliberately NOT consulted, and these cases exist so
   * that stays deliberate. The export and the import both read it, so "mirror
   * the export" argues for reading it here — I made that change and it was
   * wrong: the variable names the root of whatever host you are standing on,
   * and a validator naturally runs on the TARGET host after the import. Letting
   * it fill the SOURCE slot there points both sides at the same directory, so
   * every checksum matches and the run is green having compared nothing.
   */
  it('uses the explicit flag', () => {
    expect(resolveSourceStorageRoot('/flag')).toBe('/flag');
  });

  it('falls back to ./uploads when the flag is absent', () => {
    expect(resolveSourceStorageRoot(undefined)).toBe('./uploads');
  });

  it('ignores FILE_STORAGE_PATH even when it is set', () => {
    // BEHAVIOUR, not signature. The first version of this asserted
    // `resolveSourceStorageRoot.length === 1`, which is theatre:
    // `Function.length` counts parameters before the first defaulted one, so
    // `(argValue, envValue = process.env.FILE_STORAGE_PATH)` passes the arity
    // check, keeps every call site working, and reintroduces the self-comparison
    // in full. Setting the variable and asserting the result is the only form
    // that catches all three spellings.
    const previous = process.env.FILE_STORAGE_PATH;
    process.env.FILE_STORAGE_PATH = '/data/target-host/files';
    try {
      expect(resolveSourceStorageRoot(undefined)).toBe('./uploads');
      expect(resolveSourceStorageRoot('/explicit')).toBe('/explicit');
    } finally {
      if (previous === undefined) delete process.env.FILE_STORAGE_PATH;
      else process.env.FILE_STORAGE_PATH = previous;
    }
  });
});

describe('isSameStorageRoot', () => {
  /**
   * Both roots default to `./uploads`, so running the validator on the target
   * host after an import with neither path flag points both sides at the same
   * directory: every checksum matches, nothing is compared, success. This guard
   * is what refuses that, and `main()` — where it is called — has no test, so it
   * is asserted here instead of taken on faith.
   */
  it('detects the same directory reached by two different spellings', async () => {
    const real = path.join(tmpDir, 'same-root-real');
    await mkdir(real, { recursive: true });
    const link = path.join(tmpDir, 'same-root-link');
    await symlink(real, link, 'dir');

    expect(isSameStorageRoot(real, real)).toBe(true);
    expect(isSameStorageRoot(real, link), 'symlink to the same directory').toBe(true);
    expect(isSameStorageRoot(real, real + path.sep), 'trailing separator').toBe(true);
  });

  it('does not fire for genuinely different roots', async () => {
    const a = path.join(tmpDir, 'root-a');
    const b = path.join(tmpDir, 'root-b');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    expect(isSameStorageRoot(a, b)).toBe(false);
  });

  it('falls back to string equality when a root does not resolve', () => {
    // A nonexistent root is the readable-directory check's job; this one must
    // not throw on the way there.
    const missing = path.join(tmpDir, 'not-here');
    expect(isSameStorageRoot(missing, missing)).toBe(true);
    expect(isSameStorageRoot(missing, path.join(tmpDir, 'also-not-here'))).toBe(false);
  });
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

    it('counts the DISCOVERED user themselves, not just the requested ones', async () => {
      // The bundle carries Eve (her page chat pulled her in), so validating
      // `users` on the REQUESTED set alone compares her row on neither side: if
      // the import dropped it, this table would still print [PASS]. That is the
      // opposite direction from the rest of the map — a false pass, not a false
      // failure — and the only assertion here that catches it.
      const result = await validate();
      const usersResult = result.tableResults.find((r) => r.table === 'users');
      expect(usersResult!.sourceCount).toBe(3);
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

    /**
     * The MIRROR of the bug above, and the one the widening left open.
     *
     * Eve is DISCOVERED — her chat sits on an exported page, so the export
     * carries her and her message, and validating them is correct. This case is
     * the opposite: an author reachable by NO discovery arm, writing inside a
     * conversation the export does carry.
     *
     * tenant-export.ts filters `messages` on
     * `("userId" IS NULL OR "userId" IN (allExportedUserIdSet))`, so that row is
     * deliberately left behind. If the validator selects messages on
     * `conversationId` alone it counts a row the bundle was never meant to hold,
     * reports it MISSING, and `allTablesPassed` fails a CORRECT migration.
     *
     * Same shape for `page_permissions`, `user_mentions` and
     * `channel_message_reactions`, which carry the same user filter on the
     * export side.
     */
    it('does NOT count a message from an author outside the export set, so a correct bundle still passes', async () => {
      const STRANGER = 'test_user_stranger_004';
      const STRANGER_MSG = 'test_msg_stranger_001';
      await db.execute(sql.raw(
        `INSERT INTO users (id, name, email, "emailBidx", provider, "createdAt", "updatedAt")`
        + ` VALUES ('${STRANGER}', 'Mallory Stranger', 'mallory@test.local', 'bidx_mallory_test_local', 'email', NOW(), NOW())`,
      ));
      // Inside the OWNER's conversation — which the export carries — but from an
      // author no discovery arm reaches.
      await db.execute(sql.raw(
        `INSERT INTO messages (id, "conversationId", role, content, "userId", "createdAt")`
        + ` VALUES ('${STRANGER_MSG}', '${FIXTURES.conversations.pageChat.id}', 'user', 'not carried by the bundle', '${STRANGER}', NOW())`,
      ));

      try {
        const result = await validate();
        const messagesResult = result.tableResults.find((r) => r.table === 'messages');
        // Still 3 — the two owner messages plus Eve's; Mallory's is excluded.
        //
        // `sourceCount` only — see HARNESS LIMITATION at the top of this file
        // for why `passed` cannot move here. The count is what does: without
        // the user arm it is 4, and the bundle would be reported as missing a
        // row it was never meant to carry.
        expect(messagesResult!.sourceCount).toBe(3);
      } finally {
        await db.execute(sql.raw(`DELETE FROM messages WHERE id = '${STRANGER_MSG}'`));
        await db.execute(sql.raw(`DELETE FROM users WHERE id = '${STRANGER}'`));
      }
    });
  });

  describe('rows the export deliberately leaves behind are not counted either', () => {
    /**
     * The mirror of the block above. Each row here is one the EXPORTER filters
     * out, so the validator must filter it out too — otherwise it counts a row
     * the bundle never held, reports it MISSING, and fails a correct migration.
     *
     * One case per predicate that was wrong, because a shared fixture proves
     * nothing about which arm is doing the work: `page_permissions`,
     * `user_mentions` and `channel_message_reactions` on the row's USER, and
     * `mentions` on its TARGET PAGE. The existing fixtures could not catch any
     * of them — every seeded row belongs to a requested user and points at an
     * exported page, so all four predicates were satisfied trivially.
     */
    const STRANGER = 'test_user_stranger_100';
    const OUTSIDE_DRIVE = 'test_drive_outside_100';
    const OUTSIDE_PAGE = 'test_page_outside_100';
    const CHANNEL_PAGE = 'test_page_channel_100';
    const CHANNEL_MSG = 'test_chanmsg_100';

    beforeEach(async () => {
      // Reachable by NO discovery arm: owns no exported conversation, authors
      // no channel message, and holds no drive_members row — so `discoverDrives`
      // never finds their drive and they never enter `allExportedUserIdSet`.
      await db.execute(sql.raw(
        `INSERT INTO users (id, name, email, "emailBidx", provider, "createdAt", "updatedAt")`
        + ` VALUES ('${STRANGER}', 'Mallory', 'mallory100@test.local', 'bidx_mallory_100', 'email', NOW(), NOW())`,
      ));
      await db.execute(sql.raw(
        `INSERT INTO drives (id, name, slug, "ownerId", "createdAt", "updatedAt")`
        + ` VALUES ('${OUTSIDE_DRIVE}', 'Outside', 'outside-100', '${STRANGER}', NOW(), NOW())`,
      ));
      await db.execute(sql.raw(
        `INSERT INTO pages (id, title, type, position, "driveId", "createdAt", "updatedAt")`
        + ` VALUES ('${OUTSIDE_PAGE}', 'Outside page', 'DOCUMENT', 1, '${OUTSIDE_DRIVE}', NOW(), NOW())`,
      ));

      // page_permissions: a grant to the stranger on an EXPORTED page.
      await db.execute(sql.raw(
        `INSERT INTO page_permissions (id, "pageId", "userId", "canView", "canEdit", "canShare", "canDelete", "grantedAt")`
        + ` VALUES ('test_pp_100', '${FIXTURES.pages.root.id}', '${STRANGER}', TRUE, FALSE, FALSE, FALSE, NOW())`,
      ));
      // user_mentions: from an EXPORTED page, targeting the stranger.
      await db.execute(sql.raw(
        `INSERT INTO user_mentions (id, "sourcePageId", "targetUserId", "createdAt")`
        + ` VALUES ('test_um_100', '${FIXTURES.pages.root.id}', '${STRANGER}', NOW())`,
      ));
      // mentions: from an EXPORTED page, pointing OUT of the exported page set.
      await db.execute(sql.raw(
        `INSERT INTO mentions (id, "sourcePageId", "targetPageId", "createdAt")`
        + ` VALUES ('test_m_100', '${FIXTURES.pages.root.id}', '${OUTSIDE_PAGE}', NOW())`,
      ));
      // channel_message_reactions: the MESSAGE is the owner's (so authoring it
      // does not pull the stranger in as a discovered user) and the REACTION is
      // the stranger's.
      await db.execute(sql.raw(
        `INSERT INTO pages (id, title, type, position, "driveId", "createdAt", "updatedAt")`
        + ` VALUES ('${CHANNEL_PAGE}', 'Channel', 'CHANNEL', 9, '${FIXTURES.drives.shared.id}', NOW(), NOW())`,
      ));
      await db.execute(sql.raw(
        `INSERT INTO channel_messages (id, content, "createdAt", "pageId", "userId")`
        + ` VALUES ('${CHANNEL_MSG}', 'hi', NOW(), '${CHANNEL_PAGE}', '${FIXTURES.users.owner.id}')`,
      ));
      await db.execute(sql.raw(
        `INSERT INTO channel_message_reactions (id, "messageId", "userId", emoji, "createdAt")`
        + ` VALUES ('test_cmr_100', '${CHANNEL_MSG}', '${STRANGER}', ':wave:', NOW())`,
      ));
    });

    const validateOutside = () =>
      validateData(db as unknown as DbClient, db as unknown as DbClient, {
        sourceDatabaseUrl: getTestDatabaseUrl(),
        targetDatabaseUrl: getTestDatabaseUrl(),
        userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
        sourceFileStoragePath: fileStoragePath,
        targetFileStoragePath: fileStoragePath,
      });

    const countFor = async (table: string) => {
      const result = await validateOutside();
      return result.tableResults.find((r) => r.table === table)!.sourceCount;
    };

    it('does not count a user the export never carries', async () => {
      // The UPPER bound on `users`, paired with the lower bound in the block
      // above. `users` is the one query here whose failure mode is a false
      // PASS, so it needs both: too narrow and a carried row goes unchecked,
      // too wide and a row the bundle never held is reported missing. The
      // stranger has a `users` row and is reachable by no discovery arm.
      expect(await countFor('users')).toBe(2);
    });

    it('does not count a page permission granted to a user outside the export set', async () => {
      // Still the ONE seeded grant. Without the user arm this is 2.
      expect(await countFor('page_permissions')).toBe(1);
    });

    it('does not count a user mention targeting a user outside the export set', async () => {
      expect(await countFor('user_mentions')).toBe(1);
    });

    it('does not count a mention pointing at a page outside the export set', async () => {
      // The exporter bounds BOTH endpoints. Without the target arm this is 2.
      expect(await countFor('mentions')).toBe(1);
    });

    it('does not count a reaction by a user outside the export set', async () => {
      // The stranger's is the only reaction seeded, so the correct answer is 0.
      // Without the user arm this is 1.
      expect(await countFor('channel_message_reactions')).toBe(0);
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

  it('FAILS when the source root is unusable, rather than passing vacuously', async () => {
    // The false-PASS direction of the skips the neighbouring tests assert are
    // CORRECT. Two shapes, both ordinary operator error, both previously green:
    // a root that does not exist, and a root that is a regular FILE — the
    // latter slips past `existsSync` because `resolvePathWithin` walks up to
    // the first existing ancestor and returns the base itself.
    const asFile = path.join(tmpDir, 'root-is-a-file');
    await writeFile(asFile, 'not a directory');

    // Third shape: a real directory with no read permission. `statSync`
    // succeeds on it — stat needs no permission on the directory itself — so an
    // `isDirectory()` check waves it through while every row underneath still
    // fails to resolve. The canonical deployment root is a root-owned Docker
    // volume, so a validator run as a non-root user lands exactly here.
    const unreadable = path.join(tmpDir, 'root-unreadable');
    await mkdir(unreadable, { recursive: true });
    await chmod(unreadable, 0o000);

    try {
      for (const [label, sourceRoot] of [
        ['does not exist', path.join(tmpDir, 'nope')],
        ['is a regular file', asFile],
        ['is an unreadable directory', unreadable],
      ] as [string, string][]) {
        const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
          sourceDatabaseUrl: getTestDatabaseUrl(),
          targetDatabaseUrl: getTestDatabaseUrl(),
          userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
          sourceFileStoragePath: sourceRoot,
          targetFileStoragePath: path.join(tmpDir, 'target-none'),
        });
        expect(result.fileResults.passed, label).toBe(false);
        expect(result.fileResults.mismatches.map((m) => m.reason).join(), label)
          .toMatch(/not a readable directory/);
      }
    } finally {
      // Restore before `afterEach`'s recursive rm, which cannot descend into a
      // mode-000 directory.
      await chmod(unreadable, 0o755);
    }
  });

  it('stays green when there are no file rows at all — nothing skipped is not nothing compared', async () => {
    // Pins the `fileStorageData.length > 0` clause. Without it, a migration
    // carrying no files trips the nothing-was-compared check (0 === 0) and a
    // correct run fails — the exact regression class this branch is full of.
    await db.execute(sql.raw(`DELETE FROM files`));
    const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      sourceFileStoragePath: path.join(tmpDir, 'also-nope'),
      targetFileStoragePath: path.join(tmpDir, 'also-nope-target'),
    });
    expect(result.fileResults.passed).toBe(true);
    expect(result.fileResults.mismatches).toEqual([]);
  });

  it('does not fault a file whose storagePath escapes the storage root — the export skipped it', async () => {
    // The export resolves the source blob with `resolvePathWithin`, which
    // refuses a path escaping the storage root and SKIPS the row. A raw
    // `path.join` here follows the symlink, finds the file, and then faults the
    // row as 'missing in target' — failing a correct migration.
    //
    // A symlinked storage root is the practical trigger: `existsSync` follows
    // symlinks, so the naive check sees a real file where the export saw an
    // escape.
    const realOutside = path.join(tmpDir, 'outside-root');
    await mkdir(path.join(realOutside, 'test_file_blob_001'), { recursive: true });
    await writeFile(path.join(realOutside, 'test_file_blob_001', 'data.txt'), 'escaped');

    const linkedSource = path.join(tmpDir, 'linked-source');
    await mkdir(linkedSource, { recursive: true });
    await symlink(path.join(realOutside, 'test_file_blob_001'), path.join(linkedSource, 'test_file_blob_001'), 'dir');

    const emptyTarget = path.join(tmpDir, 'target-escaped');
    await mkdir(emptyTarget, { recursive: true });

    const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      sourceFileStoragePath: linkedSource,
      targetFileStoragePath: emptyTarget,
    });

    expect(result.fileResults.mismatches).toEqual([]);
    expect(result.fileResults.passed).toBe(true);
    // …and says so, rather than looking identical to a run that compared it.
    expect(result.fileResults.skipped).toEqual([
      { file: 'test_file_blob_001/data.txt', reason: 'did not resolve inside the source storage root' },
    ]);
  });

  it('does not fault a file whose SOURCE blob is gone — the export skipped it', async () => {
    // tenant-export.ts skips a `files` row whose blob is not on disk, so the
    // bundle legitimately does not carry it. Checking the target first reported
    // that row as 'missing in target' and failed a correct migration.
    //
    // Both paths point at empty directories: source blob absent, target blob
    // absent, which is exactly the orphaned-row state. Before the fix this
    // produced `{ reason: 'missing in target' }` and `passed: false`.
    const emptySource = path.join(tmpDir, 'source-orphaned');
    const emptyTarget = path.join(tmpDir, 'target-orphaned');
    await mkdir(emptySource, { recursive: true });
    await mkdir(emptyTarget, { recursive: true });

    const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [FIXTURES.users.owner.id, FIXTURES.users.member.id],
      sourceFileStoragePath: emptySource,
      targetFileStoragePath: emptyTarget,
    });

    expect(result.fileResults.mismatches).toEqual([]);
    expect(result.fileResults.passed).toBe(true);
    expect(result.fileResults.skipped).toEqual([
      { file: 'test_file_blob_001/data.txt', reason: 'source blob not on disk (the export skips these rows)' },
    ]);
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

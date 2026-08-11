/**
 * THE MEMORY BACKFILL, against a real Postgres.
 *
 * This script is a one-shot that runs over every existing user's profile, and
 * it had no coverage at all — the only backfill in `scripts/` without a test.
 * It is also the only one whose failure mode is a privacy leak rather than a
 * missing row, so the two questions pinned hardest here are:
 *
 *   1. **Does a re-run clobber an edit?** Idempotence is claimed via a content
 *      check (`WHERE content = ''`) rather than a stamp column, so the claim
 *      lives entirely in that predicate.
 *   2. **Is the legacy column actually retired?** `personalization-utils` stops
 *      reading a column the moment its POINTER is set, so a column left behind
 *      is unreachable — until a hard-delete nulls the pointer via
 *      `ON DELETE SET NULL`, the fallback switches back on, and content the user
 *      never saw is injected into every prompt again. Clearing only the fields
 *      this run COPIED would leave exactly that behind for any field whose page
 *      already had content.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied, like every other
 * DB-backed test in this directory.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, runMigrations, truncateAll, closePool, type TestDb } from './setup';
import { runBackfill } from '../backfill-memory-pages';

let db: TestDb;

const USER_ID = 'mem_bf_user_1';
const DRIVE_ID = 'mem_bf_drive_1';

beforeAll(async () => {
  db = createTestDb();
  await runMigrations(db);
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** A user with a Home drive and a legacy profile in the three text columns. */
async function seedLegacyProfile(
  overrides: { bio?: string | null; writingStyle?: string | null; rules?: string | null } = {},
) {
  const { bio = 'Legacy bio', writingStyle = 'Legacy style', rules = 'Legacy rules' } = overrides;

  await db.execute(sql`INSERT INTO users (id, email, name) VALUES (${USER_ID}, 'mem-bf@example.com', 'Mem BF')`);
  await db.execute(
    sql`INSERT INTO drives (id, name, slug, "ownerId", kind, "updatedAt")
        VALUES (${DRIVE_ID}, 'Home', 'home-mem-bf', ${USER_ID}, 'HOME', now())`,
  );
  await db.execute(
    sql`INSERT INTO user_personalization (id, "userId", bio, "writingStyle", rules, "updatedAt")
        VALUES ('mem_bf_up_1', ${USER_ID}, ${bio}, ${writingStyle}, ${rules}, now())`,
  );
}

async function readProfile() {
  const { rows } = await db.execute(sql`
    SELECT bio, "writingStyle", rules, "memoryFolderId", "bioPageId", "writingStylePageId", "rulesPageId"
    FROM user_personalization WHERE "userId" = ${USER_ID}
  `);
  return rows[0] as Record<string, string | null>;
}

async function readPage(pageId: string | null) {
  if (!pageId) return null;
  const { rows } = await db.execute(
    sql`SELECT title, content, "parentId" FROM pages WHERE id = ${pageId}`,
  );
  return (rows[0] ?? null) as { title: string; content: string; parentId: string | null } | null;
}

describe('backfill-memory-pages (Postgres)', () => {
  it('copies each column into a correctly-titled page under the Memory folder', async () => {
    await seedLegacyProfile();

    const summary = await runBackfill();

    expect(summary.migrated).toBe(1);
    expect(summary.fieldsCopied).toBe(3);
    expect(summary.failed).toBe(0);

    const profile = await readProfile();
    const bioPage = await readPage(profile.bioPageId);
    const stylePage = await readPage(profile.writingStylePageId);
    const rulesPage = await readPage(profile.rulesPageId);

    expect(bioPage).toMatchObject({ title: 'About You', content: 'Legacy bio' });
    expect(stylePage).toMatchObject({ title: 'Communication', content: 'Legacy style' });
    expect(rulesPage).toMatchObject({ title: 'Rules', content: 'Legacy rules' });

    // All three sit inside the Memory folder, which is what settings links to.
    expect(bioPage!.parentId).toBe(profile.memoryFolderId);
    expect(stylePage!.parentId).toBe(profile.memoryFolderId);
    expect(rulesPage!.parentId).toBe(profile.memoryFolderId);
  });

  it('retires every legacy column once the pointers are set', async () => {
    await seedLegacyProfile();

    await runBackfill();

    const profile = await readProfile();
    expect(profile.bio).toBeNull();
    expect(profile.writingStyle).toBeNull();
    expect(profile.rules).toBeNull();
  });

  it('does not clobber an edit made since the last run', async () => {
    await seedLegacyProfile();
    await runBackfill();

    const first = await readProfile();
    await db.execute(
      sql`UPDATE pages SET content = 'Hand-edited by the user' WHERE id = ${first.bioPageId}`,
    );

    const summary = await runBackfill();

    // Nothing left to do: the row no longer matches the "missing pointer"
    // predicate, so it is not even scanned.
    expect(summary.scanned).toBe(0);
    expect(await readPage(first.bioPageId)).toMatchObject({ content: 'Hand-edited by the user' });
  });

  it('retires the column of a field whose page already had content', async () => {
    // The leak this guards: the reader ignores a column as soon as its pointer
    // is set, so a column left populated here is invisible — until a hard-delete
    // nulls the pointer and the fallback resurrects it. Clearing only the fields
    // this run COPIED would leave precisely this case behind.
    await seedLegacyProfile();

    // Simulate a first run that provisioned pages, plus a hand edit to `bio`,
    // while the legacy columns were somehow still populated.
    await runBackfill();
    const first = await readProfile();
    await db.execute(
      sql`UPDATE pages SET content = 'Written before the backfill' WHERE id = ${first.bioPageId}`,
    );
    await db.execute(
      sql`UPDATE user_personalization
          SET bio = 'stale column', "bioPageId" = NULL WHERE "userId" = ${USER_ID}`,
    );

    await runBackfill();

    const profile = await readProfile();
    // The page keeps what it had; the column does NOT survive.
    expect(await readPage(profile.bioPageId)).toMatchObject({
      content: 'Written before the backfill',
    });
    expect(profile.bio).toBeNull();
  });

  it('writes nothing on a dry run', async () => {
    await seedLegacyProfile();

    const summary = await runBackfill({ dryRun: true });

    expect(summary.migrated).toBe(1);

    const profile = await readProfile();
    expect(profile.bio).toBe('Legacy bio');
    expect(profile.memoryFolderId).toBeNull();
    expect(profile.bioPageId).toBeNull();
  });

  it('provisions pages for an empty profile without inventing content', async () => {
    // An untouched profile still needs its folder and pages, so the settings
    // screen has somewhere to link and the cron has somewhere to write.
    await seedLegacyProfile({ bio: null, writingStyle: null, rules: null });

    const summary = await runBackfill();

    expect(summary.emptyProfiles).toBe(1);
    expect(summary.fieldsCopied).toBe(0);

    const profile = await readProfile();
    expect(profile.memoryFolderId).not.toBeNull();
    expect(await readPage(profile.bioPageId)).toMatchObject({ title: 'About You', content: '' });
  });

  it('skips a user with no Home drive rather than failing the run', async () => {
    // Nothing can be provisioned without a drive to provision into. The run must
    // not abort — one such user would otherwise block every user after them.
    await db.execute(sql`INSERT INTO users (id, email, name) VALUES ('mem_bf_nodrive', 'nd@example.com', 'ND')`);
    await db.execute(
      sql`INSERT INTO user_personalization (id, "userId", bio, "updatedAt")
          VALUES ('mem_bf_up_2', 'mem_bf_nodrive', 'orphan bio', now())`,
    );
    await seedLegacyProfile();

    const summary = await runBackfill();

    expect(summary.failed).toBe(0);
    expect(summary.migrated).toBe(1); // only the user who has a Home drive
  });
});

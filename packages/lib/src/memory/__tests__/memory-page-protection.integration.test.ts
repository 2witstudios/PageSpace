/**
 * The memory-page deletion guard, against a REAL Postgres.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * The unit tests beside it mock the database, so they never execute SQL. That
 * is the same blind spot that let a 42883 (`integer >= unknown`) defect into
 * the candidate query earlier in this branch — every mocked test passed while
 * the real statement could not run at all.
 *
 * These two functions gate every delete path in the app. If their SQL fails,
 * it fails *closed* in the worst way: `isProtectedMemoryPage` throws, the
 * caller 500s, and the user cannot delete ANY page. So the queries are pinned
 * here, where Postgres actually parses them.
 *
 * The bulk case matters most — it is the only one using `inArray`, whose
 * parameter expansion is exactly what a mock cannot exercise.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createId } from '@paralleldrive/cuid2';
import { isProtectedMemoryPage, findProtectedMemoryPages } from '../memory-pages';

let dbAvailable = false;

type Pointers = Awaited<ReturnType<typeof userWithMemoryPages>>;

/** A user with a Home drive, four real pages, and pointers at all four. */
async function userWithMemoryPages() {
  const user = await factories.createUser();
  const drive = await factories.createDrive(user.id);
  const folder = await factories.createPage(drive.id, { title: 'Memory' });
  const bio = await factories.createPage(drive.id, { title: 'About You' });
  const style = await factories.createPage(drive.id, { title: 'Communication' });
  const rules = await factories.createPage(drive.id, { title: 'Rules' });
  const ordinary = await factories.createPage(drive.id, { title: 'Notes' });

  await db.insert(userPersonalization).values({
    id: createId(),
    userId: user.id,
    memoryFolderId: folder.id,
    bioPageId: bio.id,
    writingStylePageId: style.id,
    rulesPageId: rules.id,
  });

  return { folder, bio, style, rules, ordinary };
}

describe('memory page protection (Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(userPersonalization).limit(1);
      dbAvailable = true;
    } catch (error) {
      // Missing Postgres is an environment failure, not a reason to report a
      // green zero-assertion pass. Only an explicit ALLOW_SKIP_DB_TESTS=1 gets
      // past this.
      requireDb('memory-page-protection.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  it('protects every pointer column, and nothing else', async () => {
    if (!dbAvailable) return;
    const { folder, bio, style, rules, ordinary } = await userWithMemoryPages();

    // All four pointers, because a guard that covered only the three pages
    // would leave the folder deletable — taking its children with it.
    expect(await isProtectedMemoryPage(folder.id)).toBe(true);
    expect(await isProtectedMemoryPage(bio.id)).toBe(true);
    expect(await isProtectedMemoryPage(style.id)).toBe(true);
    expect(await isProtectedMemoryPage(rules.id)).toBe(true);

    expect(await isProtectedMemoryPage(ordinary.id)).toBe(false);
  });

  it('does not match a row whose pointers are all NULL', async () => {
    if (!dbAvailable) return;
    // A user who has personalization but no pages yet. `col = $1` is never true
    // for NULL, but an `OR` chain over four nullable columns is easy to get
    // wrong in a way no mock would reveal.
    const user = await factories.createUser();
    const drive = await factories.createDrive(user.id);
    const page = await factories.createPage(drive.id, { title: 'Notes' });
    await db.insert(userPersonalization).values({ id: createId(), userId: user.id });

    expect(await isProtectedMemoryPage(page.id)).toBe(false);
  });

  it('returns only the requested ids from a bulk lookup', async () => {
    if (!dbAvailable) return;
    const { folder, bio, style, ordinary } = await userWithMemoryPages();

    const found = await findProtectedMemoryPages([bio.id, ordinary.id, folder.id]);

    // `style` is a pointer but was not asked about, so it must not appear —
    // the caller uses this set to name what it refused.
    expect([...found].sort()).toEqual([bio.id, folder.id].sort());
    expect(found.has(style.id)).toBe(false);
  });

  it.each([
    ['folder', (p: Pointers) => p.folder.id],
    ['bio', (p: Pointers) => p.bio.id],
    ['writingStyle', (p: Pointers) => p.style.id],
    ['rules', (p: Pointers) => p.rules.id],
  ])('finds a %s page in a batch containing no other pointer', async (_label, pick) => {
    if (!dbAvailable) return;
    const pointers = await userWithMemoryPages();
    const target = pick(pointers);

    // Each pointer column needs its OWN term in the WHERE clause. A batch that
    // also contains a sibling pointer would match the row through that sibling
    // and then find this id while walking the row's columns in JS — so a
    // missing term stays invisible until someone selects this page alone.
    const found = await findProtectedMemoryPages([target, pointers.ordinary.id]);

    expect([...found]).toEqual([target]);
  });

  it('survives a batch far larger than any hand-written fixture', async () => {
    if (!dbAvailable) return;
    const { bio } = await userWithMemoryPages();

    // Bulk-delete is driven by a user's multi-select, so the id list is
    // unbounded in practice. This is the parameter expansion a mocked
    // `inArray` cannot check.
    const ids = Array.from({ length: 300 }, () => createId()).concat([bio.id]);

    expect([...(await findProtectedMemoryPages(ids))]).toEqual([bio.id]);
  });

  it('protects a page by pointer regardless of who is deleting it', async () => {
    if (!dbAvailable) return;
    // The guard is keyed on the page, not on the requesting user. A shared or
    // admin-driven delete path must hit the same refusal, so the query must
    // not be scoped to the caller.
    const { bio } = await userWithMemoryPages();
    await userWithMemoryPages(); // a second, unrelated user with their own pages

    expect(await isProtectedMemoryPage(bio.id)).toBe(true);
  });

  it('stops protecting a page once the pointer is cleared', async () => {
    if (!dbAvailable) return;
    // The FK is ON DELETE SET NULL, so this is the state a hard-deleted page
    // leaves behind. Protection must follow the pointer rather than the title,
    // or an ordinary page later named "About You" would become undeletable.
    const user = await factories.createUser();
    const drive = await factories.createDrive(user.id);
    const impostor = await factories.createPage(drive.id, { title: 'About You' });
    await db.insert(userPersonalization).values({ id: createId(), userId: user.id });

    expect(await isProtectedMemoryPage(impostor.id)).toBe(false);
  });
});

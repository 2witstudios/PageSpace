/**
 * Integration tests for the content-tag service shell.
 *
 * These exist to prove the things a unit test CANNOT: that the service's
 * behaviour and the database's constraints agree. The partial unique indexes,
 * the five-branch CHECK and the scope trigger from migrations 0270/0272 are
 * enforced by Postgres, so a mocked db would happily accept rows the real one
 * rejects — and the whole point of putting those rules in the schema was that
 * they hold regardless of which code path writes.
 *
 * Requires a running Postgres with the latest migrations applied. Run via:
 *   ./scripts/test-with-db.sh
 *   bun run --filter '@pagespace/lib' test -- src/tags/__tests__/tag-service.integration.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages, tags } from '@pagespace/db/schema/core';
import { contentTags } from '@pagespace/db/schema/content-tags';
import { channelMessages } from '@pagespace/db/schema/chat';
import { pagePermissions, driveMembers } from '@pagespace/db/schema/members';
import {
  listDriveTags,
  upsertTag,
  applyTag,
  removeTag,
  getPageTags,
  getBatchPageTags,
} from '../tag-service';

/** Unwrap an ok result, failing loudly with the error code when it is not. */
function expectOk<T>(result: { ok: true; data: T } | { ok: false; error: string; message?: string }): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error}${result.message ? `: ${result.message}` : ''}`);
  }
  return result.data;
}

describe('tag-service (integration)', () => {
  beforeEach(async () => {
    await db.delete(contentTags);
    await db.delete(tags);
    await db.delete(channelMessages);
    await db.delete(pagePermissions);
    await db.delete(pages);
    await db.delete(driveMembers);
    await db.delete(drives);
    await db.delete(users);
  });

  /** Owner + drive + one DOCUMENT page, the shape most cases need. */
  async function seed() {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createDriveMember(drive.id, owner.id, { role: 'OWNER' });
    const page = await factories.createPage(drive.id, { type: 'DOCUMENT', title: 'Doc', position: 0 });
    return { owner, drive, page };
  }

  describe('the vocabulary is drive-scoped', () => {
    it('makes the same tag name in two drives two independent rows', async () => {
      // The bug this reclaim exists to fix: `tags.name` used to be GLOBALLY
      // unique, so the first drive to use "urgent" owned the word forever.
      const owner = await factories.createUser();
      const driveA = await factories.createDrive(owner.id);
      const driveB = await factories.createDrive(owner.id);
      await factories.createDriveMember(driveA.id, owner.id, { role: 'OWNER' });
      await factories.createDriveMember(driveB.id, owner.id, { role: 'OWNER' });

      const a = expectOk(await upsertTag(driveA.id, owner.id, { name: 'Urgent' }));
      const b = expectOk(await upsertTag(driveB.id, owner.id, { name: 'Urgent' }));

      expect(a.id).not.toBe(b.id);
      expect(a.normalizedKey).toBe(b.normalizedKey);
      const rows = await db.select().from(tags);
      expect(rows).toHaveLength(2);
    });

    it('collapses case and accent variants onto one row within a drive', async () => {
      const { owner, drive } = await seed();

      const first = expectOk(await upsertTag(drive.id, owner.id, { name: 'Café' }));
      const second = expectOk(await upsertTag(drive.id, owner.id, { name: 'CAFÉ' }));
      const third = expectOk(await upsertTag(drive.id, owner.id, { name: 'café' }));

      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(await db.select().from(tags)).toHaveLength(1);
    });

    it('returns an existing tag UNMODIFIED rather than restyling it', async () => {
      // upsert here means get-or-create. A second caller passing a different
      // colour must not repaint a vocabulary entry the whole drive shares.
      const { owner, drive } = await seed();

      const created = expectOk(await upsertTag(drive.id, owner.id, { name: 'Urgent', color: '#ff0000', description: 'first' }));
      const again = expectOk(await upsertTag(drive.id, owner.id, { name: 'urgent', color: '#00ff00', description: 'second' }));

      expect(again.id).toBe(created.id);
      expect(again.color).toBe('#ff0000');
      expect(again.description).toBe('first');
    });

    it('rejects a name the pure core rejects, without touching the database', async () => {
      const { owner, drive } = await seed();

      const result = await upsertTag(drive.id, owner.id, { name: '   ' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('invalid_name');
      expect(await db.select().from(tags)).toHaveLength(0);
    });
  });

  describe('the partial unique indexes', () => {
    it('rejects a SECOND page-level assignment of the same tag', async () => {
      const { owner, drive, page } = await seed();
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'urgent' }));

      const first = await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'page' }, source: 'user' });
      expect(first.ok).toBe(true);

      // `content_tags_page_target_unique` is partial: UNIQUE (pageId, tagId)
      // WHERE targetKind = 'page'. A duplicate is a driver error, which the
      // service converts rather than leaking.
      const second = await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'page' }, source: 'user' });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error).toBe('internal_error');

      expect(await db.select().from(contentTags)).toHaveLength(1);
    });

    it('ACCEPTS a second anchored assignment of the same tag on the same page', async () => {
      // The reason content_tags is not a composite-PK join table: one tag
      // legitimately attaches many times to one page at different offsets.
      // No partial index covers 'text', and that is deliberate.
      const { owner, drive, page } = await seed();
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'todo' }));

      const anchorAt = (start: number) => ({
        v: 1 as const,
        exact: 'some quoted words',
        prefix: 'before ',
        suffix: ' after',
        start,
        end: start + 17,
        revision: 1,
        textHash: 'deadbeef',
      });

      const a = await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'text', anchor: anchorAt(10) }, source: 'user' });
      const b = await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'text', anchor: anchorAt(200) }, source: 'user' });

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(await db.select().from(contentTags)).toHaveLength(2);
    });
  });

  describe('target kinds and the CHECK constraint', () => {
    it('inserts a page-level tag with every discriminated column null', async () => {
      const { owner, drive, page } = await seed();
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'a' }));

      expectOk(await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'page' }, source: 'user' }));

      const [row] = await db.select().from(contentTags);
      expect(row.targetKind).toBe('page');
      expect(row.anchor).toBeNull();
      expect(row.anchorStatus).toBeNull();
      expect(row.channelMessageId).toBeNull();
      expect(row.aiMessageId).toBeNull();
    });

    it("stamps a fresh text anchor 'exact', which the CHECK requires to be non-null", async () => {
      const { owner, drive, page } = await seed();
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'b' }));

      expectOk(await applyTag(owner.id, {
        pageId: page.id,
        tagId: tag.id,
        target: { kind: 'text', anchor: { v: 1, exact: 'q', prefix: '', suffix: '', start: 0, end: 1, revision: 1, textHash: 'h' } },
        source: 'ai',
        confidence: 0.75,
      }));

      const [row] = await db.select().from(contentTags);
      expect(row.targetKind).toBe('text');
      expect(row.anchorStatus).toBe('exact');
      expect(row.anchor).not.toBeNull();
      expect(row.source).toBe('ai');
      expect(row.confidence).toBeCloseTo(0.75);
    });

    it('rejects a target kind the page type does not accept', async () => {
      // TAG_TARGETS says DOCUMENT takes ['page', 'text'] only. The pure core
      // refuses before the database is asked, so the error is actionable
      // rather than a constraint violation.
      const { owner, drive, page } = await seed();
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'c' }));

      const result = await applyTag(owner.id, {
        pageId: page.id,
        tagId: tag.id,
        target: { kind: 'sheet_cell', anchor: { v: 1, sheet: 'Sheet1', address: 'A1' } },
        source: 'user',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('invalid_target');
      expect(await db.select().from(contentTags)).toHaveLength(0);
    });

    it('refuses a tag from another drive rather than leaking a driver error', async () => {
      const { owner, page } = await seed();
      const otherDrive = await factories.createDrive(owner.id);
      await factories.createDriveMember(otherDrive.id, owner.id, { role: 'OWNER' });
      const foreign = expectOk(await upsertTag(otherDrive.id, owner.id, { name: 'foreign' }));

      const result = await applyTag(owner.id, { pageId: page.id, tagId: foreign.id, target: { kind: 'page' }, source: 'user' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('tag_not_found');
    });
  });

  describe('permission denial returns a result, never a throw', () => {
    /** A user with no membership and no page permission anywhere. */
    async function outsider() {
      return factories.createUser();
    }

    it('refuses to list a drive vocabulary to a non-member', async () => {
      const { drive } = await seed();
      const stranger = await outsider();

      const result = await listDriveTags(drive.id, stranger.id);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('forbidden');
    });

    it('refuses to create a tag in a drive the caller is not in', async () => {
      const { drive } = await seed();
      const stranger = await outsider();

      const result = await upsertTag(drive.id, stranger.id, { name: 'sneaky' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('forbidden');
      expect(await db.select().from(tags)).toHaveLength(0);
    });

    it('refuses to tag a page the caller cannot edit', async () => {
      const { owner, drive, page } = await seed();
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'x' }));
      const stranger = await outsider();

      const result = await applyTag(stranger.id, { pageId: page.id, tagId: tag.id, target: { kind: 'page' }, source: 'user' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('forbidden');
      expect(await db.select().from(contentTags)).toHaveLength(0);
    });

    it('reports a nonexistent page as forbidden, not as not_found', async () => {
      // Distinguishing the two would let a caller probe which page ids exist
      // inside drives they cannot see.
      const { owner } = await seed();

      const result = await applyTag(owner.id, {
        pageId: 'does-not-exist',
        name: 'y',
        target: { kind: 'page' },
        source: 'user',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('forbidden');
    });

    it('checks removeTag against the row OWN page, not against caller input', async () => {
      const { owner, drive, page } = await seed();
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'z' }));
      const assignment = expectOk(await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'page' }, source: 'user' }));
      const stranger = await outsider();

      const result = await removeTag(stranger.id, assignment.id);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('forbidden');
      expect(await db.select().from(contentTags)).toHaveLength(1);
    });

    it('reports an unknown assignment id distinctly from a forbidden one', async () => {
      const { owner } = await seed();

      const result = await removeTag(owner.id, 'no-such-assignment');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('assignment_not_found');
    });

    it('hides a page the caller cannot view from getPageTags', async () => {
      const { page } = await seed();
      const stranger = await outsider();

      const result = await getPageTags(stranger.id, page.id);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('forbidden');
    });
  });

  describe('the batch read path', () => {
    it('OMITS unviewable pages rather than returning them empty', async () => {
      // "no tags" and "not allowed to know" are different answers. A caller
      // that renders them the same way should have to choose that.
      const { owner, drive, page } = await seed();
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'shared' }));
      expectOk(await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'page' }, source: 'user' }));

      const stranger = await factories.createUser();
      const strangerDrive = await factories.createDrive(stranger.id);
      await factories.createDriveMember(strangerDrive.id, stranger.id, { role: 'OWNER' });
      const strangerPage = await factories.createPage(strangerDrive.id, { type: 'DOCUMENT', title: 'Theirs', position: 0 });

      const map = expectOk(await getBatchPageTags(stranger.id, [page.id, strangerPage.id]));

      expect(map.has(page.id)).toBe(false);
      expect(map.get(strangerPage.id)).toEqual([]);
    });

    it('buckets assignments by page and seeds viewable pages with an empty array', async () => {
      const { owner, drive, page } = await seed();
      const second = await factories.createPage(drive.id, { type: 'DOCUMENT', title: 'Second', position: 1 });
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'bucket' }));
      expectOk(await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'page' }, source: 'user' }));

      const map = expectOk(await getBatchPageTags(owner.id, [page.id, second.id]));

      expect(map.get(page.id)).toHaveLength(1);
      expect(map.get(second.id)).toEqual([]);
    });

    it('returns an empty map for an empty request without querying', async () => {
      const { owner } = await seed();
      const map = expectOk(await getBatchPageTags(owner.id, []));
      expect(map.size).toBe(0);
    });

    it('joins the vocabulary so a caller gets the name, not just an id', async () => {
      const { owner, drive, page } = await seed();
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'Named', color: '#abcdef' }));
      expectOk(await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'page' }, source: 'user' }));

      const [assignment] = expectOk(await getPageTags(owner.id, page.id));

      expect(assignment.name).toBe('Named');
      expect(assignment.color).toBe('#abcdef');
      expect(assignment.tagId).toBe(tag.id);
    });
  });
});

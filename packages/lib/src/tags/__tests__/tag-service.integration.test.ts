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
 *   bun run --filter '@pagespace/lib' test:integration -- src/tags/__tests__/tag-service.integration.test.ts
 *
 * `test:integration`, not `test`: vitest.config.ts EXCLUDES this file from the
 * default run, so the documented `test` command silently matched nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages, tags } from '@pagespace/db/schema/core';
import { contentTags } from '@pagespace/db/schema/content-tags';
import { projectContent } from '../../content/anchoring/text-projection';
import { hashText } from '../../content/anchoring/anchor';
import { channelMessages } from '@pagespace/db/schema/chat';
import { pagePermissions, driveMembers } from '@pagespace/db/schema/members';
import {
  listDriveTags,
  upsertTag,
  applyTag,
  removeTag,
  getPageTags,
  getBatchPageTags,
  reanchorPageTags,
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
      // WHERE targetKind = 'page'. Re-tagging is a normal user action, so the
      // service reports it as a CONFLICT — a caller that mapped it to
      // internal_error would show a server failure for a double click.
      const second = await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'page' }, source: 'user' });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error).toBe('assignment_exists');

      expect(await db.select().from(contentTags)).toHaveLength(1);
    });

    it('ACCEPTS a second anchored assignment of the same tag on the same page', async () => {
      // The reason content_tags is not a composite-PK join table: one tag
      // legitimately attaches many times to one page at different offsets.
      // No partial index covers 'text', and that is deliberate.
      const owner = await factories.createUser();
      const drive = await factories.createDrive(owner.id);
      await factories.createDriveMember(drive.id, owner.id, { role: 'OWNER' });
      // The anchors must quote text that really is in this page, because
      // applyTag now repairs a client anchor against the current revision and
      // refuses one whose quote is absent.
      const CONTENT = 'some quoted words appear here, and some quoted words appear again later.';
      const page = await factories.createPage(drive.id, {
        type: 'DOCUMENT', title: 'Doc', position: 0, content: CONTENT, contentMode: 'markdown',
      });
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'todo' }));

      const projected = projectContent(CONTENT, 'markdown');
      const anchorAt = (start: number) => ({
        v: 1 as const,
        exact: 'some quoted words',
        prefix: projected.slice(Math.max(0, start - 32), start),
        suffix: projected.slice(start + 17, start + 49),
        start,
        end: start + 17,
        revision: 1,
        textHash: hashText(projected),
      });

      const a = await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'text', anchor: anchorAt(projected.indexOf('some quoted words')) }, source: 'user' });
      const b = await applyTag(owner.id, { pageId: page.id, tagId: tag.id, target: { kind: 'text', anchor: anchorAt(projected.lastIndexOf('some quoted words')) }, source: 'user' });

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
      const owner = await factories.createUser();
      const drive = await factories.createDrive(owner.id);
      await factories.createDriveMember(drive.id, owner.id, { role: 'OWNER' });
      const CONTENT = 'q is the quoted character.';
      const page = await factories.createPage(drive.id, {
        type: 'DOCUMENT', title: 'Doc', position: 0, content: CONTENT, contentMode: 'markdown',
      });
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'b' }));
      const projected = projectContent(CONTENT, 'markdown');

      expectOk(await applyTag(owner.id, {
        pageId: page.id,
        tagId: tag.id,
        target: { kind: 'text', anchor: { v: 1, exact: 'q', prefix: '', suffix: projected.slice(1, 33), start: 0, end: 1, revision: 1, textHash: hashText(projected) } },
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

  describe('reanchorPageTags across successive edits', () => {
    const BODY = 'Alpha beta gamma. The anchored quote sits here. Delta epsilon.';
    const QUOTE = 'The anchored quote sits here.';

    /** Build a page whose content is `BODY`, with one text anchor on QUOTE. */
    async function seedAnchored() {
      const owner = await factories.createUser();
      const drive = await factories.createDrive(owner.id);
      await factories.createDriveMember(drive.id, owner.id, { role: 'OWNER' });
      const page = await factories.createPage(drive.id, {
        type: 'DOCUMENT',
        title: 'Doc',
        position: 0,
        content: BODY,
        contentMode: 'markdown',
      });
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'anchored' }));

      const start = BODY.indexOf(QUOTE);
      const projected = projectContent(BODY, 'markdown');
      expectOk(await applyTag(owner.id, {
        pageId: page.id,
        tagId: tag.id,
        source: 'user',
        target: {
          kind: 'text',
          anchor: {
            v: 1,
            exact: QUOTE,
            prefix: BODY.slice(Math.max(0, start - 32), start),
            suffix: BODY.slice(start + QUOTE.length, start + QUOTE.length + 32),
            start,
            end: start + QUOTE.length,
            revision: 1,
            textHash: hashText(projected),
          },
        },
      }));
      return { owner, drive, page };
    }

    it('keeps forward-porting an anchor through a SECOND edit that follows a first', async () => {
      // THE FAILURE THIS PINS: an edit AFTER the anchored range leaves the
      // status 'exact' and the offsets untouched, so a write-skipping
      // optimisation would leave the row holding the PREVIOUS revision's
      // textHash. The next sweep's staleness guard then rejects the anchor and
      // it silently stops being forward-ported — for good. Editing below your
      // anchors is the ordinary way to write a document, so this is the common
      // path, not a corner.
      const { page } = await seedAnchored();

      const afterFirst = `${BODY} Appended sentence one.`;
      const first = expectOk(await reanchorPageTags(page.id, BODY, afterFirst));
      expect(first.considered).toBe(1);
      expect(first.skippedStaleHash).toBe(0);

      const afterSecond = `${afterFirst} Appended sentence two.`;
      const second = expectOk(await reanchorPageTags(page.id, afterFirst, afterSecond));

      expect(second.considered).toBe(1);
      expect(second.skippedStaleHash, 'the anchor must still be portable after the first edit').toBe(0);
    });

    it('stores the hash of the projection the anchor now describes', async () => {
      const { page } = await seedAnchored();
      const edited = `${BODY} Appended.`;

      expectOk(await reanchorPageTags(page.id, BODY, edited));

      const [row] = await db.select().from(contentTags).where(eq(contentTags.pageId, page.id));
      const stored = row.anchor as { textHash: string };
      expect(stored.textHash).toBe(hashText(projectContent(edited, 'markdown')));
    });
  });

  describe('reanchorPageTags joins the caller transaction', () => {
    const BODY2 = 'Alpha beta gamma. The anchored quote sits here. Delta epsilon.';
    const QUOTE2 = 'The anchored quote sits here.';

    async function seedForTx() {
      const owner = await factories.createUser();
      const drive = await factories.createDrive(owner.id);
      await factories.createDriveMember(drive.id, owner.id, { role: 'OWNER' });
      const page = await factories.createPage(drive.id, {
        type: 'DOCUMENT', title: 'Doc', position: 0, content: BODY2, contentMode: 'markdown',
      });
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'tx' }));
      const start = BODY2.indexOf(QUOTE2);
      expectOk(await applyTag(owner.id, {
        pageId: page.id, tagId: tag.id, source: 'user',
        target: { kind: 'text', anchor: {
          v: 1, exact: QUOTE2, prefix: '', suffix: '',
          start, end: start + QUOTE2.length, revision: 1,
          textHash: hashText(projectContent(BODY2, 'markdown')),
        } },
      }));
      return { page };
    }

    it('rolls the sweep back with the caller transaction', async () => {
      // The reason this takes an executor at all. applyPageMutation holds both
      // revisions in ONE transaction; a sweep that commits independently can
      // leave anchors ported to content that never landed.
      const { page } = await seedForTx();
      const before = await db.select().from(contentTags).where(eq(contentTags.pageId, page.id));
      const beforeHash = (before[0].anchor as { textHash: string }).textHash;

      await expect(
        db.transaction(async (tx) => {
          const swept = await reanchorPageTags(page.id, BODY2, `${BODY2} Appended.`, { executor: tx });
          expect(swept.ok).toBe(true);
          throw new Error('caller rolls back after the sweep');
        }),
      ).rejects.toThrow('caller rolls back');

      const after = await db.select().from(contentTags).where(eq(contentTags.pageId, page.id));
      expect((after[0].anchor as { textHash: string }).textHash).toBe(beforeHash);
    });

    it('commits with the caller transaction when it succeeds', async () => {
      const { page } = await seedForTx();
      const edited = `${BODY2} Appended.`;

      await db.transaction(async (tx) => {
        expectOk(await reanchorPageTags(page.id, BODY2, edited, { executor: tx }));
      });

      const [row] = await db.select().from(contentTags).where(eq(contentTags.pageId, page.id));
      expect((row.anchor as { textHash: string }).textHash).toBe(hashText(projectContent(edited, 'markdown')));
    });
  });

  describe('reanchorPageTags across a content-mode conversion', () => {
    it('repairs anchors instead of skipping the whole sweep', async () => {
      // convert-content-mode is the case the epic routes to QUOTE REPAIR
      // rather than forward-porting. Reading one stored mode for both
      // revisions breaks it in both directions: the old mode makes the formats
      // look like an accidental flip and skips everything, while the new mode
      // projects the old HTML as raw text so every anchor fails its hash check.
      const owner = await factories.createUser();
      const drive = await factories.createDrive(owner.id);
      await factories.createDriveMember(drive.id, owner.id, { role: 'OWNER' });

      const OLD_HTML = '<p>Alpha beta gamma.</p><p>The anchored quote sits here.</p>';
      const NEW_MD = 'Alpha beta gamma.\n\nThe anchored quote sits here.';
      const QUOTE3 = 'The anchored quote sits here.';

      // The page has ALREADY been converted when the sweep runs, so its stored
      // mode is the new one — which is precisely why the old mode must be passed.
      const page = await factories.createPage(drive.id, {
        type: 'DOCUMENT', title: 'Doc', position: 0, content: NEW_MD, contentMode: 'markdown',
      });
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'converted' }));

      const oldProjection = projectContent(OLD_HTML, 'html');
      const start = oldProjection.indexOf(QUOTE3);
      expect(start, 'the quote must exist in the old projection').toBeGreaterThanOrEqual(0);

      // Inserted DIRECTLY, not through applyTag. The row has to predate the
      // conversion — it describes the old HTML revision — and applyTag now
      // (correctly) repairs a client anchor onto whatever the page currently
      // holds, which would normalise away the very thing under test.
      await db.insert(contentTags).values({
        tagId: tag.id,
        pageId: page.id,
        targetKind: 'text',
        anchor: {
          v: 1, exact: QUOTE3, prefix: '', suffix: '',
          start, end: start + QUOTE3.length, revision: 1,
          textHash: hashText(oldProjection),
        },
        anchorStatus: 'exact',
        source: 'user',
        createdBy: owner.id,
      });

      const swept = expectOk(await reanchorPageTags(page.id, OLD_HTML, NEW_MD, {
        oldContentMode: 'html',
        newContentMode: 'markdown',
      }));

      expect(swept.considered).toBe(1);
      expect(swept.skippedFormatFlip, 'a declared conversion is not an accidental flip').toBe(0);
      expect(swept.skippedStaleHash, 'the old mode must project the old content correctly').toBe(0);

      const [row] = await db.select().from(contentTags).where(eq(contentTags.pageId, page.id));
      expect(row.anchorStatus).not.toBe('orphaned');
      const stored = row.anchor as { start: number; end: number };
      expect(projectContent(NEW_MD, 'markdown').slice(stored.start, stored.end)).toBe(QUOTE3);
    });
  });

  describe('an anchor arriving from a client is untrusted', () => {
    async function anchoredPage() {
      const owner = await factories.createUser();
      const drive = await factories.createDrive(owner.id);
      await factories.createDriveMember(drive.id, owner.id, { role: 'OWNER' });
      const CONTENT = 'Alpha beta gamma. The anchored quote sits here. Delta.';
      const page = await factories.createPage(drive.id, {
        type: 'DOCUMENT', title: 'Doc', position: 0, content: CONTENT, contentMode: 'markdown',
      });
      const tag = expectOk(await upsertTag(drive.id, owner.id, { name: 'client' }));
      return { owner, page, tag, CONTENT, projected: projectContent(CONTENT, 'markdown') };
    }

    it('rejects a structurally malformed anchor instead of persisting it', async () => {
      // validateTarget answers which KINDS a page type takes; it does not
      // inspect the anchor's scalars, and the compiler cannot help with parsed
      // JSON. Without a runtime check `exact: 1` persists and every later sweep
      // casts it back to TextAnchor.
      const { owner, page, tag } = await anchoredPage();

      const result = await applyTag(owner.id, {
        pageId: page.id, tagId: tag.id, source: 'user',
        target: { kind: 'text', anchor: { v: 1, exact: 1, prefix: '', suffix: '', start: 0, end: 1, revision: 1, textHash: 'x' } as never },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('invalid_target');
      expect(await db.select().from(contentTags)).toHaveLength(0);
    });

    it('repairs a stale anchor onto the current revision rather than storing a lie', async () => {
      // A collaborative edit can land between the client measuring an anchor
      // and this call. Storing it as 'exact' against a revision it was never
      // measured on means the next sweep's staleness guard rejects it and it is
      // never ported again.
      const { owner, page, tag, projected } = await anchoredPage();
      const QUOTE = 'The anchored quote sits here.';
      const trueStart = projected.indexOf(QUOTE);

      const result = expectOk(await applyTag(owner.id, {
        pageId: page.id, tagId: tag.id, source: 'user',
        target: { kind: 'text', anchor: {
          v: 1, exact: QUOTE, prefix: '', suffix: '',
          start: trueStart + 25, end: trueStart + 25 + QUOTE.length,
          revision: 1, textHash: 'a-hash-from-some-other-revision',
        } },
      }));

      const [row] = await db.select().from(contentTags).where(eq(contentTags.id, result.id));
      const stored = row.anchor as { start: number; end: number; textHash: string };
      expect(stored.textHash, 're-pinned to the revision actually stored').toBe(hashText(projected));
      expect(projected.slice(stored.start, stored.end)).toBe(QUOTE);
      expect(row.anchorStatus, 'a repaired anchor must not claim it was exact').not.toBe('exact');
    });

    it('refuses an anchor whose quote is absent from the current revision', async () => {
      const { owner, page, tag } = await anchoredPage();

      const result = await applyTag(owner.id, {
        pageId: page.id, tagId: tag.id, source: 'user',
        target: { kind: 'text', anchor: {
          v: 1, exact: 'text that was never in this document', prefix: '', suffix: '',
          start: 0, end: 36, revision: 1, textHash: 'stale',
        } },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('invalid_target');
    });
  });
});

/**
 * ART 15 SCOPE for `content_tags`, against a REAL Postgres.
 *
 * `collectUserContentTags` cannot filter on `createdBy` alone, and this is the
 * test that pins why. Removing someone from a drive deletes their
 * `drive_members` row and NOTHING else — every `content_tags` row they authored
 * survives the removal, carrying a `tagId`, a `pageId` and, for an anchored
 * tag, the verbatim passage they quoted. A collector keyed on authorship would
 * therefore let a FORMER member pull live page titles, the drive's shared tag
 * vocabulary and quoted page text out of a workspace they can no longer read,
 * through their own account export. Art 15 is a right to one's own data, not a
 * channel back into a drive one has left.
 *
 * So the collector draws the boundary `collectUserPages` already draws — the
 * subject's CURRENT drives — and these cases assert both directions of it. A
 * chain-mocked unit test cannot express this: the thing under test is a
 * PREDICATE over rows whose authorship and whose drive membership disagree.
 *
 * Requires a live `DATABASE_URL` with migrations applied. It does NOT skip when
 * one is missing, following `agent-workspace-export.integration.test.ts`: a
 * compliance test that passes silently on an unreachable database reports green
 * on the exact question it did not ask.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { inArray } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives, tags } from '@pagespace/db/schema/core';
import { contentTags } from '@pagespace/db/schema/content-tags';
import { factories } from '@pagespace/db/test/factories';
import { collectUserContentTags } from '../gdpr-export';

type DB = Parameters<typeof collectUserContentTags>[0];
const database = db as unknown as DB;

/** The data subject. Currently a member of `memberDriveId`, formerly of `leftDriveId`. */
let subjectId: string;
/** Another person, who owns both drives. */
let ownerId: string;

let memberDriveId: string;
let leftDriveId: string;

const created = {
  users: [] as string[],
  drives: [] as string[],
  tags: [] as string[],
};

beforeAll(async () => {
  const subject = await factories.createUser();
  const owner = await factories.createUser();
  subjectId = subject.id;
  ownerId = owner.id;
  created.users.push(subjectId, ownerId);

  // Both drives are owned by the OTHER person, so the subject reaches them
  // only through membership — which is what makes removing it meaningful.
  const memberDrive = await factories.createDrive(ownerId);
  const leftDrive = await factories.createDrive(ownerId);
  memberDriveId = memberDrive.id;
  leftDriveId = leftDrive.id;
  created.drives.push(memberDriveId, leftDriveId);

  // The subject is a member of the first drive only. There is deliberately NO
  // `drive_members` row for the second — that IS the "was removed" state, since
  // removal deletes the membership row and leaves everything else behind.
  await factories.createDriveMember(memberDriveId, subjectId);

  const memberPage = await factories.createPage(memberDriveId, { title: 'Still a member here' });
  const leftPage = await factories.createPage(leftDriveId, { title: 'Left this drive' });

  const [memberTag, leftTag] = await Promise.all([
    insertTag(memberDriveId, 'Risk'),
    insertTag(leftDriveId, 'Secret Roadmap'),
  ]);

  await database.insert(contentTags).values([
    // Authored by the subject, in a drive they are still in — must travel.
    {
      id: createId(),
      tagId: memberTag,
      pageId: memberPage.id,
      targetKind: 'page',
      source: 'user',
      createdBy: subjectId,
      updatedAt: new Date(),
    },
    // Authored by the subject, in the drive they LEFT — must not travel, even
    // though `createdBy` still names them.
    {
      id: createId(),
      tagId: leftTag,
      pageId: leftPage.id,
      targetKind: 'text',
      anchor: { v: 1, exact: 'the passage they quoted', prefix: '', suffix: '', start: 0, end: 23, revision: 1, textHash: 'deadbeefdeadbeef' },
      anchorStatus: 'exact',
      source: 'user',
      createdBy: subjectId,
      updatedAt: new Date(),
    },
    // Somebody else's tag in a drive the subject IS in — must not travel either.
    {
      id: createId(),
      tagId: memberTag,
      pageId: memberPage.id,
      targetKind: 'text',
      anchor: { v: 1, exact: 'not the subject\'s words', prefix: '', suffix: '', start: 0, end: 23, revision: 1, textHash: 'cafebabecafebabe' },
      anchorStatus: 'exact',
      source: 'user',
      createdBy: ownerId,
      updatedAt: new Date(),
    },
  ]);
});

async function insertTag(driveId: string, name: string): Promise<string> {
  const id = createId();
  await database.insert(tags).values({
    id,
    driveId,
    name,
    normalizedKey: name.toLowerCase(),
    createdBy: ownerId,
    updatedAt: new Date(),
  });
  created.tags.push(id);
  return id;
}

afterAll(async () => {
  // `content_tags` goes with its `tags` and `pages` cascades; `pages` goes with
  // the drive. Deleting the two roots is enough.
  if (created.drives.length) await database.delete(drives).where(inArray(drives.id, created.drives));
  if (created.users.length) await database.delete(users).where(inArray(users.id, created.users));
});

describe('collectUserContentTags — Art 15 scope', () => {
  it('carries a tag the subject applied in a drive they are still a member of', async () => {
    const rows = await collectUserContentTags(database, subjectId);
    expect(rows.map((r) => r.tagName)).toEqual(['Risk']);
    expect(rows[0].pageTitle).toBe('Still a member here');
  });

  it('carries NOTHING from a drive the subject was removed from, though createdBy still names them', async () => {
    const rows = await collectUserContentTags(database, subjectId);
    // The failure this pins is a leak, so assert on the leaked VALUES, not just
    // a count: the tag name and the quoted passage are the drive's content.
    expect(rows.map((r) => r.tagName)).not.toContain('Secret Roadmap');
    expect(rows.map((r) => r.pageTitle)).not.toContain('Left this drive');
    expect(JSON.stringify(rows)).not.toContain('the passage they quoted');
  });

  it('carries no other person\'s tag from a drive the subject shares with them', async () => {
    const rows = await collectUserContentTags(database, subjectId);
    expect(JSON.stringify(rows)).not.toContain("not the subject's words");
  });

  it('returns nothing at all for a subject with no drives, without querying', async () => {
    const stranger = await factories.createUser();
    created.users.push(stranger.id);
    expect(await collectUserContentTags(database, stranger.id)).toEqual([]);
  });
});

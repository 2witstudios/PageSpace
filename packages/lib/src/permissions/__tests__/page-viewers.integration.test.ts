/**
 * Integration tests for `getUsersWhoCanViewPage`.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   ./scripts/test-with-db.sh
 *   bun run --filter '@pagespace/lib' test -- src/permissions/__tests__/page-viewers.integration.test.ts
 *
 * Why this exists as an integration test rather than a unit test: the decision
 * itself is already pinned without a database (resolve-page-permission-row.test.ts).
 * What is NOT provable there is the half that actually broke — the query. The
 * channel inbox fan-out used to resolve recipients with its own joins covering
 * drive owners, admins and explicit grants, but not the rule that any accepted
 * member can view a non-private page, so ordinary members of a public channel
 * silently stopped receiving events for channels they can plainly read.
 *
 * A wrong join produces exactly that failure again while every pure-function
 * test stays green, so the assertion that matters is the round trip: for every
 * user, `getUsersWhoCanViewPage` must agree with `getBatchPagePermissions`,
 * which is the function the rest of the app asks. Each case below therefore
 * checks the membership set AND cross-checks it against the other direction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { pagePermissions, driveMembers } from '@pagespace/db/schema/members';
import { getUsersWhoCanViewPage, getBatchPagePermissions } from '../permissions';

/**
 * The invariant: asking "who can see this page" and asking each of them "can
 * you see this page" must return the same set. Drift between the two is the
 * bug class this whole helper exists to make impossible.
 */
async function expectAgreesWithPerUserCheck(pageId: string, candidateIds: string[]) {
  const viewers = await getUsersWhoCanViewPage(pageId, candidateIds);

  const perUser = new Set<string>();
  for (const userId of candidateIds) {
    const perms = await getBatchPagePermissions(userId, [pageId]);
    if (perms.get(pageId)?.canView) perUser.add(userId);
  }

  expect([...viewers].sort()).toEqual([...perUser].sort());
  return viewers;
}

describe('getUsersWhoCanViewPage (integration)', () => {
  beforeEach(async () => {
    await db.delete(pagePermissions);
    await db.delete(pages);
    await db.delete(driveMembers);
    await db.delete(drives);
    await db.delete(users);
  });

  it('includes an accepted member of a non-private channel with no explicit grant', async () => {
    // The regression case: this user has no page_permissions row and is not an
    // admin, so the old hand-written fan-out query dropped them entirely.
    const owner = await factories.createUser();
    const member = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const channel = await factories.createPage(drive.id, { type: 'CHANNEL', isPrivate: false });
    await factories.createDriveMember(drive.id, member.id);

    const viewers = await expectAgreesWithPerUserCheck(channel.id, [owner.id, member.id]);

    expect(viewers.has(member.id)).toBe(true);
    expect(viewers.has(owner.id)).toBe(true);
  });

  it('excludes a member of a PRIVATE page unless explicitly granted', async () => {
    const owner = await factories.createUser();
    const plain = await factories.createUser();
    const granted = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const page = await factories.createPage(drive.id, { type: 'CHANNEL', isPrivate: true });
    await factories.createDriveMember(drive.id, plain.id);
    await factories.createDriveMember(drive.id, granted.id);
    await factories.createPagePermission(page.id, granted.id, { canView: true });

    const viewers = await expectAgreesWithPerUserCheck(page.id, [plain.id, granted.id]);

    expect(viewers.has(plain.id)).toBe(false);
    expect(viewers.has(granted.id)).toBe(true);
  });

  it('honours an explicit deny over member access to a non-private page', async () => {
    const owner = await factories.createUser();
    const denied = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const channel = await factories.createPage(drive.id, { type: 'CHANNEL', isPrivate: false });
    await factories.createDriveMember(drive.id, denied.id);
    await factories.createPagePermission(channel.id, denied.id, { canView: false });

    const viewers = await expectAgreesWithPerUserCheck(channel.id, [denied.id]);

    expect(viewers.has(denied.id)).toBe(false);
  });

  it('includes a non-member holding an unexpired grant, and excludes an expired one', async () => {
    const owner = await factories.createUser();
    const outsider = await factories.createUser();
    const expired = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const channel = await factories.createPage(drive.id, { type: 'CHANNEL', isPrivate: false });
    // Neither is a drive member — the grant is the only reason they'd qualify.
    await factories.createPagePermission(channel.id, outsider.id, {
      canView: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await factories.createPagePermission(channel.id, expired.id, {
      canView: true,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const viewers = await expectAgreesWithPerUserCheck(channel.id, [outsider.id, expired.id]);

    expect(viewers.has(outsider.id)).toBe(true);
    expect(viewers.has(expired.id)).toBe(false);
  });

  it('excludes an invitee who has not accepted', async () => {
    const owner = await factories.createUser();
    const pending = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const channel = await factories.createPage(drive.id, { type: 'CHANNEL', isPrivate: false });
    await factories.createDriveMember(drive.id, pending.id, { acceptedAt: null });

    const viewers = await expectAgreesWithPerUserCheck(channel.id, [pending.id]);

    expect(viewers.has(pending.id)).toBe(false);
  });

  it('excludes a stranger with no membership and no grant', async () => {
    const owner = await factories.createUser();
    const stranger = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const channel = await factories.createPage(drive.id, { type: 'CHANNEL', isPrivate: false });

    const viewers = await expectAgreesWithPerUserCheck(channel.id, [stranger.id]);

    expect(viewers.has(stranger.id)).toBe(false);
  });

  it('grants nobody on a trashed page, member or owner', async () => {
    const owner = await factories.createUser();
    const member = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const channel = await factories.createPage(drive.id, {
      type: 'CHANNEL',
      isPrivate: false,
      isTrashed: true,
    });
    await factories.createDriveMember(drive.id, member.id);

    const viewers = await expectAgreesWithPerUserCheck(channel.id, [owner.id, member.id]);

    expect(viewers.size).toBe(0);
  });

  it('evaluates every candidate across the chunk boundary', async () => {
    // The candidate list is chunked at 200; a chunking bug silently drops the
    // tail, which reads as "those members just do not get notified".
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const channel = await factories.createPage(drive.id, { type: 'CHANNEL', isPrivate: false });

    const members: string[] = [];
    for (let i = 0; i < 205; i++) {
      const u = await factories.createUser();
      await factories.createDriveMember(drive.id, u.id);
      members.push(u.id);
    }

    const viewers = await getUsersWhoCanViewPage(channel.id, members);

    expect(viewers.size).toBe(members.length);
    // Specifically the ones past the first chunk.
    expect(viewers.has(members[200])).toBe(true);
    expect(viewers.has(members[204])).toBe(true);
  });

  it('returns nobody for an empty candidate list without touching the database', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const channel = await factories.createPage(drive.id, { type: 'CHANNEL' });

    expect((await getUsersWhoCanViewPage(channel.id, [])).size).toBe(0);
  });
});

// @vitest-environment node
/**
 * D-OW-62 against PostgreSQL: a Pulse summary records as contributing every org whose content it may restate. The
 * calendar context reads events the person only ATTENDS (no membership or page grant in the event's drive) and pending
 * RSVPs, so those events' drives count as sources: an attendee-only org-drive event contributes its org.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';

import { fetchCalendarContext, pulseSourceOrgIds } from '../calendar-context';

const HOUR = 60 * 60_000;
const created = { users: [] as string[], orgs: [] as string[] };

async function person() {
  const user = await factories.createUser();
  created.users.push(user.id);
  return user;
}

/** An org owned by `ownerId` with one drive, and an event in it `attendeeId` is invited to with `status`. */
async function orgEventFor(ownerId: string, attendeeId: string, status: 'ACCEPTED' | 'PENDING', startsInMs: number) {
  const [org] = await db.insert(organizations).values({ name: 'Acme', slug: `acme-${createId()}`, ownerId, policies: { requireStrongSignIn: true } }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: ownerId, role: 'OWNER' });
  const orgDrive = await factories.createDrive(ownerId, { orgId: org.id, orgVisibility: 'OPEN' });
  const startAt = new Date(Date.now() + startsInMs);
  const [event] = await db.insert(calendarEvents).values({
    driveId: orgDrive.id, createdById: ownerId, title: 'Acme board prep', location: 'Room 4',
    startAt, endAt: new Date(startAt.getTime() + HOUR), visibility: 'ATTENDEES_ONLY',
  }).returning();
  await db.insert(eventAttendees).values({ eventId: event.id, userId: attendeeId, status });
  return { org, orgDrive };
}

const window = () => {
  const now = new Date();
  return { now, endOfToday: new Date(now.getTime() + 12 * HOUR), endOfTomorrow: new Date(now.getTime() + 36 * HOUR) };
};

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe('Pulse calendar provenance', () => {
  it('SEC-2 (partial) an org-drive event the person only attends contributes its org to the summary\'s orgs', async () => {
    const owner = await person();
    const attendee = await person();
    const { org, orgDrive } = await orgEventFor(owner.id, attendee.id, 'ACCEPTED', HOUR);

    const calendar = await fetchCalendarContext({ userId: attendee.id, driveIds: [], ...window() });
    expect(calendar.allEvents.map((e) => e.title)).toContain('Acme board prep');
    expect(calendar.sourceDriveIds).toEqual([orgDrive.id]);
    expect(await pulseSourceOrgIds({ driveIds: [], pageIds: [], calendar })).toEqual([org.id]);
  });

  it('SEC-2 (partial) a pending invite to a later org-drive event contributes its org too', async () => {
    const owner = await person();
    const attendee = await person();
    const { org } = await orgEventFor(owner.id, attendee.id, 'PENDING', 5 * 24 * HOUR);

    const calendar = await fetchCalendarContext({ userId: attendee.id, driveIds: [], ...window() });
    expect(calendar.pendingInvites.map((e) => e.eventTitle)).toEqual(['Acme board prep']);
    expect(await pulseSourceOrgIds({ driveIds: [], pageIds: [], calendar })).toEqual([org.id]);
  });

  it('SEC-2 (partial) personal events contribute no org', async () => {
    const user = await person();
    const now = new Date();
    await db.insert(calendarEvents).values({
      driveId: null, createdById: user.id, title: 'Dentist', startAt: new Date(now.getTime() + HOUR), endAt: new Date(now.getTime() + 2 * HOUR),
    });

    const calendar = await fetchCalendarContext({ userId: user.id, driveIds: [], ...window() });
    expect(calendar.allEvents.map((e) => e.title)).toEqual(['Dentist']);
    expect(calendar.sourceDriveIds).toEqual([]);
    expect(await pulseSourceOrgIds({ driveIds: [], pageIds: [], calendar })).toEqual([]);
  });
});

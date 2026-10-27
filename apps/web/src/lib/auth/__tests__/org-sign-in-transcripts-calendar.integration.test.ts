// @vitest-environment node
/**
 * SEC-2/3 against PostgreSQL, for the identity-derived reads that bypass a drive's own gate: an AI conversation's
 * transcript (its owner reads it by being its owner) and a calendar event (its creator and attendees read it by being
 * named on it). Both are content of an org drive when they live in one, so a credential the org's sign-in policy refuses
 * is refused them with the actionable code, and the listings omit them — while a credential the org admits keeps them.
 *
 * Real sessions and MCP tokens, authenticated by the production request path from the token string alone.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users, mcpTokens } from '@pagespace/db/schema/auth';
import { conversations } from '@pagespace/db/schema/conversations';
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';

import { GET as getGlobalMessages } from '@/app/api/ai/global/[id]/messages/route';
import { GET as getV1Conversation } from '@/app/api/v1/conversations/[id]/route';
import { GET as listV1Conversations } from '@/app/api/v1/conversations/route';
import { GET as getEvent } from '@/app/api/calendar/events/[eventId]/route';
import { GET as getEventAttendees } from '@/app/api/calendar/events/[eventId]/attendees/route';
import { GET as listEvents } from '@/app/api/calendar/events/route';

const MINUTE = 60_000;
const created = { users: [] as string[], orgs: [] as string[] };

const evidence = (assurance: VerifiedAuthentication['assurance']): VerifiedAuthentication =>
  ({ authenticatedAtMs: Date.now(), assurance });
const bearer = (token: string): HeadersInit => ({ authorization: `Bearer ${token}` });

/** A passkey-only org owning a drive with one page; the person owns all of it. */
async function passkeyOnlyOrg() {
  const person = await factories.createUser();
  created.users.push(person.id);
  const [org] = await db.insert(organizations).values({
    name: 'Northwind', slug: `nw-${createId()}`, ownerId: person.id,
    policies: { requireStrongSignIn: true },
  }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: person.id, role: 'OWNER' });
  const orgDrive = await factories.createDrive(person.id, { orgId: org.id, orgVisibility: 'OPEN' });
  const orgPage = await factories.createPage(orgDrive.id, { title: 'Roadmap', content: 'org secret' });
  return { person, orgDrive, orgPage };
}

const session = (userId: string, assurance: VerifiedAuthentication['assurance']) =>
  sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 24 * 60 * MINUTE, authentication: evidence(assurance) });

async function mcpToken(userId: string, assurance: VerifiedAuthentication['assurance']) {
  const { token, hash, tokenPrefix } = generateToken('mcp');
  await db.insert(mcpTokens).values({
    userId, tokenHash: hash, tokenPrefix, name: 'cli', isScoped: false,
    authenticatedAt: new Date(), authenticationAssurance: assurance,
  });
  return token;
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe('AI conversation transcripts of an org page', () => {
  async function pageConversation() {
    const nw = await passkeyOnlyOrg();
    const [conversation] = await db.insert(conversations).values({
      userId: nw.person.id, type: 'page', contextId: nw.orgPage.id, title: 'Roadmap chat', updatedAt: new Date(),
    }).returning();
    return { ...nw, conversation };
  }

  it('SEC-2 (partial) the owner of an org page conversation is refused its transcript through a single-factor web session, with the sign-in code; a passkey session reads it', async () => {
    const { person, conversation } = await pageConversation();
    const read = (token: string) => getGlobalMessages(
      new Request(`https://app.test/api/ai/global/${conversation.id}/messages`, { headers: bearer(token) }),
      { params: Promise.resolve({ id: conversation.id }) },
    );

    const weak = await read(await session(person.id, 'single_factor'));
    expect(weak.status).toBe(403);
    expect(await weak.json()).toMatchObject({ code: 'org_strong_sign_in_required' });

    expect((await read(await session(person.id, 'user_verified_passkey'))).status).toBe(200);
  });

  it('SEC-2 (partial) through the v1 API a single-factor MCP token is refused the org page conversation with the sign-in code and the list omits it; a passkey-stamped token reads and lists it', async () => {
    const { person, conversation } = await pageConversation();
    const read = (token: string) => getV1Conversation(
      new Request(`https://app.test/api/v1/conversations/${conversation.id}`, { headers: bearer(token) }),
      { params: Promise.resolve({ id: conversation.id }) },
    );
    const listedIds = async (token: string) => {
      const res = await listV1Conversations(new Request('https://app.test/api/v1/conversations', { headers: bearer(token) }));
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { id: string }[] };
      return body.data.map((row) => row.id);
    };

    const weak = await mcpToken(person.id, 'single_factor');
    const weakRead = await read(weak);
    expect(weakRead.status).toBe(403);
    expect(await weakRead.json()).toMatchObject({ code: 'org_strong_sign_in_required' });
    expect(await listedIds(weak)).not.toContain(conversation.id);

    const strong = await mcpToken(person.id, 'user_verified_passkey');
    expect((await read(strong)).status).toBe(200);
    expect(await listedIds(strong)).toContain(conversation.id);
  });
});

describe('calendar events in an org drive', () => {
  async function orgEvent() {
    const nw = await passkeyOnlyOrg();
    const startAt = new Date(Date.now() + 60 * MINUTE);
    const [event] = await db.insert(calendarEvents).values({
      driveId: nw.orgDrive.id, createdById: nw.person.id, title: 'Board prep', visibility: 'ATTENDEES_ONLY',
      startAt, endAt: new Date(startAt.getTime() + 30 * MINUTE), updatedAt: new Date(),
    }).returning();
    await db.insert(eventAttendees).values({ eventId: event.id, userId: nw.person.id, isOrganizer: true, status: 'ACCEPTED' });
    return { ...nw, event };
  }

  const readEvent = (eventId: string, token: string) => getEvent(
    new Request(`https://app.test/api/calendar/events/${eventId}`, { headers: bearer(token) }),
    { params: Promise.resolve({ eventId }) },
  );
  const readAttendees = (eventId: string, token: string) => getEventAttendees(
    new Request(`https://app.test/api/calendar/events/${eventId}/attendees`, { headers: bearer(token) }),
    { params: Promise.resolve({ eventId }) },
  );
  const listedEventIds = async (token: string) => {
    const from = new Date(Date.now() - 24 * 60 * MINUTE).toISOString();
    const to = new Date(Date.now() + 24 * 60 * MINUTE).toISOString();
    const res = await listEvents(new Request(`https://app.test/api/calendar/events?startDate=${from}&endDate=${to}`, { headers: bearer(token) }));
    expect(res.status).toBe(200);
    const body = await res.json() as { events: { id: string }[] };
    return body.events.map((e) => e.id);
  };

  it('SEC-2 (partial) the creator and attendee of an org-drive event is refused it, and its attendee list, through a single-factor session with the sign-in code, and the calendar omits it', async () => {
    const { person, event } = await orgEvent();
    const weak = await session(person.id, 'single_factor');

    const eventRes = await readEvent(event.id, weak);
    expect(eventRes.status).toBe(403);
    expect(await eventRes.json()).toMatchObject({ code: 'org_strong_sign_in_required' });

    const attendeesRes = await readAttendees(event.id, weak);
    expect(attendeesRes.status).toBe(403);
    expect(await attendeesRes.json()).toMatchObject({ code: 'org_strong_sign_in_required' });

    expect(await listedEventIds(weak)).not.toContain(event.id);
  });

  it('SEC-2 (partial) a passkey session reaches the same org-drive event, its attendees and its calendar entry', async () => {
    const { person, event } = await orgEvent();
    const strong = await session(person.id, 'user_verified_passkey');

    expect((await readEvent(event.id, strong)).status).toBe(200);
    expect((await readAttendees(event.id, strong)).status).toBe(200);
    expect(await listedEventIds(strong)).toContain(event.id);
  });
});

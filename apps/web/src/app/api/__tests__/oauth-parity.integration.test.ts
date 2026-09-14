/**
 * mcp_ key ⇄ OAuth drive grant parity, against a real Postgres — Phase 2
 * acceptance (epic yv08hib74nrtmksdzxmf5nkw, US2; ADR 0002 Decision 2).
 *
 * The same user holds two credentials with the same drive scope and role — a
 * drive-scoped `mcp_` key (an `mcp_token_drives` row) and a third-party
 * `ps_at_` access token (`drive:X:<role>`) — and a third, identity-only
 * `profile` token. Every request below runs the REAL route handler over the
 * REAL `authenticateRequestWithOptions`, token lookup and permission helpers,
 * so what is compared is what production would answer:
 *
 *   - in drive X: the pinned status for the role, and an identical body (reads) or
 *     body shape (writes, which mint fresh ids) for both credentials;
 *   - in drive Y: an identical refusal (status and body);
 *   - the profile token: refused on every content route;
 *   - `/api/auth/me`: the right disclosure for each credential.
 *
 * Stubbed only: realtime broadcasts, the audit sink, the distributed rate
 * limiter, Google Calendar push, and the two object-storage effects (page content snapshots, S3
 * presign). Requires DATABASE_URL → a migrated
 * Postgres; FAILS LOUDLY when unreachable.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { mcpTokenDrives } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { ensureTestDb } from '@/test/ensure-test-db';

// Calendar writes defer Google sync with next/server's after(); run it inline.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: vi.fn((task: () => unknown) => { void Promise.resolve().then(task).catch(() => undefined); }),
}));
vi.mock('@/lib/integrations/google-calendar/push-service', () => ({
  pushEventToGoogle: vi.fn(async () => undefined),
  pushEventUpdateToGoogle: vi.fn(async () => undefined),
  pushEventDeleteToGoogle: vi.fn(async () => undefined),
}));
vi.mock('@/lib/websocket', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/websocket')>();
  return {
    ...real,
    broadcastPageEvent: vi.fn(async () => undefined),
    broadcastDriveEvent: vi.fn(async () => undefined),
    broadcastTaskEvent: vi.fn(async () => undefined),
    broadcastCalendarEvent: vi.fn(async () => undefined),
    broadcastDriveMemberEvent: vi.fn(async () => undefined),
  };
});
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/security/distributed-rate-limit')>()),
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true, attemptsRemaining: 99 })),
}));
// Page content snapshots go to object storage for version history — an
// infrastructure dependency orthogonal to authorization; the ref is recorded
// in Postgres exactly as a real write would record it.
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>();
  const { createHash } = await import('node:crypto');
  return {
    ...real,
    writePageContent: vi.fn(async (content: string, format: string) => {
      const size = Buffer.byteLength(content, 'utf8');
      return { ref: `${format}:${createHash('sha256').update(content).digest('hex')}`, size, compressed: false, storedSize: size, compressionRatio: 1 };
    }),
  };
});
// createPageVersion reaches writePageContent through a relative import inside
// @pagespace/lib, which the mock above cannot intercept; the version snapshot is
// the same object-storage write, so it is stubbed at the package boundary too.
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>();
  const { createId: id } = await import('@paralleldrive/cuid2');
  return {
    ...real,
    createPageVersion: vi.fn(async (input: { content: string }) => {
      const size = Buffer.byteLength(input.content, 'utf8');
      return { id: id(), contentRef: 'parity-snapshot', contentSize: size, compressed: false, storedSize: size, compressionRatio: 1 };
    }),
  };
});
vi.mock('@/lib/upload/s3-effects', () => ({
  checkObjectExists: vi.fn(async () => false),
  issuePresignedPutUrl: vi.fn(async () => 'https://storage.example/put'),
}));

import { GET as drivePagesGET } from '../drives/[driveId]/pages/route';
import { GET as pageGET, PATCH as pagePATCH } from '../pages/[pageId]/route';
import { POST as pagesPOST } from '../pages/route';
import { PATCH as reorderPATCH } from '../pages/reorder/route';
import { GET as tasksGET } from '../tasks/route';
import { POST as taskCreatePOST } from '../pages/[pageId]/tasks/route';
import { GET as regexSearchGET } from '../drives/[driveId]/search/regex/route';
import { GET as driveAgentsGET } from '../drives/[driveId]/agents/route';
import { GET as agentConversationsGET } from '../ai/page-agents/[agentId]/conversations/route';
import { GET as calendarEventsGET, POST as calendarEventsPOST } from '../calendar/events/route';
import { GET as eventGET, PATCH as eventPATCH, DELETE as eventDELETE } from '../calendar/events/[eventId]/route';
import { GET as attendeesGET, POST as attendeesPOST, PATCH as attendeesPATCH, DELETE as attendeesDELETE } from '../calendar/events/[eventId]/attendees/route';
import { GET as eventDrivesGET, POST as eventDrivesPOST, DELETE as eventDrivesDELETE } from '../calendar/events/[eventId]/drives/route';
import { POST as presignPOST } from '../upload/presign/route';
import { POST as mcpDocumentsPOST } from '../mcp/documents/route';
import { GET as meGET } from '../auth/me/route';

type Role = 'MEMBER' | 'ADMIN';

interface DriveFixture {
  driveId: string;
  docId: string;
  taskListId: string;
  agentId: string;
}

interface Credentials {
  mcp: string;
  oauth: string;
  profile: string;
}

const API = 'http://localhost/api';

function req(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

/** One representative call per route, parameterised by the drive it targets. */
interface RouteCase {
  readonly name: string;
  /** A read: both credentials must get the byte-identical body, not just its shape. */
  readonly read: boolean;
  /** What both credentials get in the granted drive, by role — pinned so parity is never two matching failures. */
  readonly statusInX: Readonly<Record<Role, number>>;
  readonly call: (token: string, d: DriveFixture) => Promise<Response>;
}

const OK = { MEMBER: 200, ADMIN: 200 } as const;

const RANGE = `startDate=${encodeURIComponent('2026-01-01T00:00:00Z')}&endDate=${encodeURIComponent('2026-12-31T00:00:00Z')}`;

const ROUTES: readonly RouteCase[] = [
  { name: 'list pages — GET /api/drives/[driveId]/pages', read: true, statusInX: OK, call: (t, d) => drivePagesGET(req('GET', `/drives/${d.driveId}/pages`, t) as never, params({ driveId: d.driveId })) },
  { name: 'read page — GET /api/pages/[pageId]', read: true, statusInX: OK, call: (t, d) => pageGET(req('GET', `/pages/${d.docId}`, t), params({ pageId: d.docId })) },
  { name: 'create page — POST /api/pages', read: false, statusInX: { MEMBER: 201, ADMIN: 201 }, call: (t, d) => pagesPOST(req('POST', '/pages', t, { title: 'Parity page', type: 'DOCUMENT', driveId: d.driveId })) },
  { name: 'update content — PATCH /api/pages/[pageId]', read: false, statusInX: { MEMBER: 403, ADMIN: 200 }, call: (t, d) => pagePATCH(req('PATCH', `/pages/${d.docId}`, t, { content: '<p>parity</p>' }), params({ pageId: d.docId })) },
  { name: 'move page — PATCH /api/pages/reorder', read: false, statusInX: { MEMBER: 403, ADMIN: 200 }, call: (t, d) => reorderPATCH(req('PATCH', '/pages/reorder', t, { pageId: d.docId, newParentId: null, newPosition: 5 })) },
  { name: 'list tasks — GET /api/tasks', read: true, statusInX: OK, call: (t, d) => tasksGET(req('GET', `/tasks?context=drive&driveId=${d.driveId}`, t)) },
  { name: 'create task — POST /api/pages/[pageId]/tasks', read: false, statusInX: { MEMBER: 403, ADMIN: 201 }, call: (t, d) => taskCreatePOST(req('POST', `/pages/${d.taskListId}/tasks`, t, { title: 'Parity task' }), params({ pageId: d.taskListId })) },
  { name: 'search — GET /api/drives/[driveId]/search/regex', read: true, statusInX: OK, call: (t, d) => regexSearchGET(req('GET', `/drives/${d.driveId}/search/regex?pattern=parity`, t), params({ driveId: d.driveId })) },
  { name: 'list agents — GET /api/drives/[driveId]/agents', read: true, statusInX: OK, call: (t, d) => driveAgentsGET(req('GET', `/drives/${d.driveId}/agents`, t), params({ driveId: d.driveId })) },
  { name: 'list conversations — GET /api/ai/page-agents/[agentId]/conversations', read: true, statusInX: OK, call: (t, d) => agentConversationsGET(req('GET', `/ai/page-agents/${d.agentId}/conversations`, t), params({ agentId: d.agentId })) },
  { name: 'calendar list — GET /api/calendar/events', read: true, statusInX: OK, call: (t, d) => calendarEventsGET(req('GET', `/calendar/events?context=drive&driveId=${d.driveId}&${RANGE}`, t)) },
  { name: 'upload presign — POST /api/upload/presign', read: false, statusInX: OK, call: (t, d) => presignPOST(req('POST', '/upload/presign', t, { contentHash: 'a'.repeat(64), driveId: d.driveId, filename: 'parity.txt', mimeType: 'text/plain', fileSize: 12 })) },
  { name: 'MCP document read — POST /api/mcp/documents', read: true, statusInX: OK, call: (t, d) => mcpDocumentsPOST(req('POST', '/mcp/documents', t, { operation: 'read', pageId: d.docId }) as never) },
];

/**
 * The structure of a JSON value with every leaf reduced to its type, so two
 * responses built from different rows (new ids, timestamps) still compare.
 * Arrays compare by the shape of their first element.
 */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]));
  }
  return value === null ? 'null' : typeof value;
}

async function answer(res: Response): Promise<{ status: number; body: unknown }> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON body — compared verbatim
  }
  return { status: res.status, body };
}

async function drive(ownerId: string): Promise<DriveFixture> {
  const created = await factories.createDrive(ownerId);
  const doc = await factories.createPage(created.id, { title: 'Parity doc', content: '<p>parity content</p>' });
  const taskList = await factories.createPage(created.id, { title: 'Parity tasks', type: 'TASK_LIST', content: '' });
  const agent = await factories.createPage(created.id, { title: 'Parity agent', type: 'AI_CHAT', content: '' });
  return { driveId: created.id, docId: doc.id, taskListId: taskList.id, agentId: agent.id };
}

async function credentialsFor(userId: string, driveId: string, role: Role): Promise<Credentials> {
  const mcp = generateToken('mcp');
  const [key] = await db
    .insert(mcpTokens)
    .values({ userId, tokenHash: mcp.hash, tokenPrefix: mcp.tokenPrefix, name: 'parity key', isScoped: true })
    .returning();
  await db.insert(mcpTokenDrives).values({ tokenId: key.id, driveId, role });

  const clientId = `app_${createId()}`;
  const [client] = await db
    .insert(oauthClients)
    .values({
      clientId,
      name: 'Parity App',
      clientType: 'public',
      redirectUris: ['https://parity.example/callback'],
      allowedGrantTypes: ['authorization_code', 'refresh_token'],
      allowedScopes: ['profile', 'drive:member', 'drive:admin', 'offline_access'],
      ownerUserId: userId,
      verified: false,
    })
    .returning();

  const mint = async (scopes: string[]) => {
    const access = generateToken('ps_at');
    await db.insert(oauthAccessTokens).values({
      tokenHash: access.hash,
      tokenPrefix: access.tokenPrefix,
      familyId: createId(),
      clientId: client.id,
      userId,
      scopes,
      tokenVersion: 0,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    return access.token;
  };

  return {
    mcp: mcp.token,
    oauth: await mint([`drive:${driveId}:${role.toLowerCase()}`]),
    profile: await mint(['profile']),
  };
}

beforeAll(async () => {
  await ensureTestDb();
});

describe.each<Role>(['MEMBER', 'ADMIN'])('mcp_ key ⇄ OAuth drive grant parity, real database (role %s)', (role) => {
  let userId: string;
  let x: DriveFixture;
  let y: DriveFixture;
  let creds: Credentials;

  beforeAll(async () => {
    const user = await factories.createUser();
    userId = user.id;
    // The user OWNS both drives: every difference below is the credential, never the person.
    x = await drive(userId);
    y = await drive(userId);
    creds = await credentialsFor(userId, x.driveId, role);
  });

  describe('in the granted drive X — the pinned status, identical body (reads) or body shape (writes)', () => {
    it.each(ROUTES.map((r) => [r.name, r] as const))('%s', async (_name, route) => {
      const viaKey = await answer(await route.call(creds.mcp, x));
      const viaGrant = await answer(await route.call(creds.oauth, x));
      expect(viaKey.status, JSON.stringify(viaKey).slice(0, 400)).toBe(route.statusInX[role]);
      expect(viaGrant.status, JSON.stringify(viaGrant).slice(0, 400)).toBe(route.statusInX[role]);
      if (route.read) {
        expect(viaGrant.body).toEqual(viaKey.body);
      } else {
        expect(shapeOf(viaGrant.body)).toEqual(shapeOf(viaKey.body));
      }
    }, 30_000);
  });

  describe('in the ungranted drive Y — the identical refusal', () => {
    it.each(ROUTES.map((r) => [r.name, r] as const))('%s', async (_name, route) => {
      const viaKey = await answer(await route.call(creds.mcp, y));
      const viaGrant = await answer(await route.call(creds.oauth, y));
      expect(viaKey.status, JSON.stringify(viaKey)).toBeGreaterThanOrEqual(403);
      expect(viaKey.status).not.toBe(500);
      expect(viaGrant).toEqual(viaKey);
    }, 30_000);
  });

  describe('a profile-only token — refused on every content route', () => {
    it.each(ROUTES.map((r) => [r.name, r] as const))('%s', async (_name, route) => {
      for (const target of [x, y]) {
        const res = await answer(await route.call(creds.profile, target));
        expect(res.status, JSON.stringify(res)).toBe(403);
      }
    }, 30_000);
  });

  describe('personal (driveless) calendar events', () => {
    const personalEvent = async (title: string) => {
      const [row] = await db
        .insert(calendarEvents)
        .values({ createdById: userId, driveId: null, title, startAt: new Date('2026-06-01T09:00:00Z'), endAt: new Date('2026-06-01T10:00:00Z') })
        .returning();
      await db.insert(eventAttendees).values({ eventId: row.id, userId, isOrganizer: true, status: 'ACCEPTED' });
      return row.id;
    };

    it('the profile token is refused at the door; the mcp_ key lists the user\'s own personal event; the OAuth grant does not', async () => {
      await personalEvent('Personal listing event');
      const list = (token: string) => calendarEventsGET(req('GET', `/calendar/events?context=user&${RANGE}`, token));

      expect((await list(creds.profile)).status).toBe(403);

      const viaKey = await answer(await list(creds.mcp));
      expect(viaKey.status).toBe(200);
      expect(JSON.stringify(viaKey.body)).toContain('Personal listing event');

      const viaGrant = await answer(await list(creds.oauth));
      expect(viaGrant.status).toBe(200);
      expect(JSON.stringify(viaGrant.body)).not.toContain('Personal listing event');
    }, 30_000);

    // Consent names only the app's drives, never the user's personal calendar
    // (US10): for an OAuth principal every calendar route treats a driveless
    // event as out of scope. mcp_ keys keep #1846's own-personal-event rule.
    type PersonalCase = { name: string; mcpStatus: number; call: (token: string, eventId: string) => Promise<Response> };
    const PERSONAL: readonly PersonalCase[] = [
      { name: 'POST /api/calendar/events (driveless)', mcpStatus: 201, call: (t) => calendarEventsPOST(req('POST', '/calendar/events', t, { title: 'New personal', startAt: '2026-06-02T09:00:00Z', endAt: '2026-06-02T10:00:00Z', timezone: 'UTC' })) },
      { name: 'GET /api/calendar/events/[eventId]', mcpStatus: 200, call: (t, e) => eventGET(req('GET', `/calendar/events/${e}`, t), params({ eventId: e })) },
      { name: 'PATCH /api/calendar/events/[eventId]', mcpStatus: 200, call: (t, e) => eventPATCH(req('PATCH', `/calendar/events/${e}`, t, { title: 'Renamed personal' }), params({ eventId: e })) },
      { name: 'GET /api/calendar/events/[eventId]/attendees', mcpStatus: 200, call: (t, e) => attendeesGET(req('GET', `/calendar/events/${e}/attendees`, t), params({ eventId: e })) },
      { name: 'PATCH /api/calendar/events/[eventId]/attendees (RSVP)', mcpStatus: 200, call: (t, e) => attendeesPATCH(req('PATCH', `/calendar/events/${e}/attendees`, t, { status: 'TENTATIVE' }), params({ eventId: e })) },
      { name: 'POST /api/calendar/events/[eventId]/attendees', mcpStatus: 200, call: (t, e) => attendeesPOST(req('POST', `/calendar/events/${e}/attendees`, t, { userIds: [userId] }), params({ eventId: e })) },
      { name: 'DELETE /api/calendar/events/[eventId]/attendees', mcpStatus: 400, call: (t, e) => attendeesDELETE(req('DELETE', `/calendar/events/${e}/attendees?userId=${userId}`, t), params({ eventId: e })) },
      { name: 'GET /api/calendar/events/[eventId]/drives', mcpStatus: 200, call: (t, e) => eventDrivesGET(req('GET', `/calendar/events/${e}/drives`, t), params({ eventId: e })) },
      { name: 'POST /api/calendar/events/[eventId]/drives', mcpStatus: 400, call: (t, e) => eventDrivesPOST(req('POST', `/calendar/events/${e}/drives`, t, { driveId: x.driveId }), params({ eventId: e })) },
      { name: 'DELETE /api/calendar/events/[eventId]/drives', mcpStatus: 404, call: (t, e) => eventDrivesDELETE(req('DELETE', `/calendar/events/${e}/drives?driveId=${x.driveId}`, t), params({ eventId: e })) },
      { name: 'DELETE /api/calendar/events/[eventId]', mcpStatus: 200, call: (t, e) => eventDELETE(req('DELETE', `/calendar/events/${e}`, t), params({ eventId: e })) },
    ];

    it.each(PERSONAL.map((c) => [c.name, c] as const))('%s — OAuth grant refused, mcp_ key unchanged', async (_name, route) => {
      const forGrant = await personalEvent('Personal for grant');
      const viaGrant = await answer(await route.call(creds.oauth, forGrant));
      expect(viaGrant, JSON.stringify(viaGrant)).toEqual({ status: 403, body: { error: 'This token does not have access to this event' } });

      const forKey = await personalEvent('Personal for key');
      const viaKey = await answer(await route.call(creds.mcp, forKey));
      expect(viaKey.status, JSON.stringify(viaKey).slice(0, 300)).toBe(route.mcpStatus);
    }, 30_000);
  });

  describe('/api/auth/me — the right disclosure for each credential', () => {
    it('refuses the mcp_ key at the door (me admits no mcp)', async () => {
      expect((await meGET(req('GET', '/auth/me', creds.mcp))).status).toBe(401);
    });

    it('gives the third-party drive grant (no profile consent) no identity', async () => {
      const res = await meGET(req('GET', '/auth/me', creds.oauth));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'insufficient_scope' });
    });

    it('gives the profile token exactly id, name, email, image', async () => {
      const res = await meGET(req('GET', '/auth/me', creds.profile));
      expect(res.status).toBe(200);
      expect(Object.keys(await res.json()).sort()).toEqual(['email', 'id', 'image', 'name']);
    });
  });
});

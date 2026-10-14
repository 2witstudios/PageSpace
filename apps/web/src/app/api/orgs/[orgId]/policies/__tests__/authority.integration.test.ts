// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { ceremonyAuthentication } from '@pagespace/lib/auth/authentication-evidence';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { getOrgPolicies } from '@pagespace/lib/organizations/policy-reader';
import { PATCH } from '../route';

const userIds: string[] = [];
const orgIds: string[] = [];
afterEach(async () => {
  if (orgIds.length) await db.delete(organizations).where(inArray(organizations.id, orgIds.splice(0)));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

it('ARCH-4 a real Admin session admitted before its streamed body loses mutation authority when removal commits; an Owner control still succeeds', { timeout: 15_000 }, async () => {
  const owner = await factories.createUser();
  const admin = await factories.createUser();
  userIds.push(owner.id, admin.id);
  const [org] = await db.insert(organizations).values({ ownerId: owner.id, name: 'Streamed authority', slug: `streamed-${createId()}` }).returning();
  orgIds.push(org.id);
  await db.insert(orgMembers).values([{ orgId: org.id, userId: owner.id, role: 'OWNER' }, { orgId: org.id, userId: admin.id, role: 'ADMIN' }]);
  const token = await sessionService.createSession({ userId: admin.id, type: 'user', scopes: [], expiresInMs: 60_000, authentication: ceremonyAuthentication({ method: 'magic_link' }, Date.now()) });
  const claims = await sessionService.validateSession(token);
  expect(claims).not.toBeNull();
  const headers = { Cookie: `session=${token}`, 'X-CSRF-Token': generateCSRFToken(claims!.sessionId), 'Content-Type': 'application/json' };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let signalRead!: () => void;
  const readStarted = new Promise<void>(resolve => { signalRead = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { signalRead(); } }, { highWaterMark: 0 });
  const context = { params: Promise.resolve({ orgId: org.id }) };
  const request = new Request(`https://pagespace.ai/api/orgs/${org.id}/policies`, { method: 'PATCH', headers, body, ...{ duplex: 'half' } });
  const pending = PATCH(request, context);
  // Request.json starts only after real session/role admission; pause here before the mutation.
  await readStarted;
  await db.delete(orgMembers).where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, admin.id)));
  controller.enqueue(new TextEncoder().encode('{"guests":"off"}'));
  controller.close();
  expect((await pending).status).toBe(404);
  expect((await getOrgPolicies(org.id)).guests).not.toBe('off');

  const ownerToken = await sessionService.createSession({ userId: owner.id, type: 'user', scopes: [], expiresInMs: 60_000, authentication: ceremonyAuthentication({ method: 'magic_link' }, Date.now()) });
  const ownerClaims = await sessionService.validateSession(ownerToken);
  expect(ownerClaims).not.toBeNull();
  const control = await PATCH(new Request(request.url, { method: 'PATCH', headers: { Cookie: `session=${ownerToken}`, 'X-CSRF-Token': generateCSRFToken(ownerClaims!.sessionId), 'Content-Type': 'application/json' }, body: '{"guests":"off"}' }), context);
  expect(control.status).toBe(200);
  expect((await getOrgPolicies(org.id)).guests).toBe('off');
});

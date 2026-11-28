// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: () => false, getAllowedDriveIds: () => [] }));
vi.mock('@/lib/orgs/org-avatar-storage', () => ({ mintOrgAvatarToken: vi.fn(async () => 'test-org-token'), callOrgAvatarStorage: vi.fn() }));
vi.mock('@/lib/org-billing/org-subscription', () => ({ endOrgSubscriptionPort: () => async () => undefined }));
vi.mock('@pagespace/lib/organizations/org-change-events', () => ({ orgChangeAudience: vi.fn(), announceOrgChangeTo: vi.fn(), announceOrgChange: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
import { authenticateRequestWithOptions } from '@/lib/auth';
import { callOrgAvatarStorage } from '@/lib/orgs/org-avatar-storage';
import { orgChangeAudience } from '@pagespace/lib/organizations/org-change-events';
import { DELETE } from '../[orgId]/route';
import { POST } from '../[orgId]/avatar/route';

const userIds: string[] = [];
let orgId: string | null = null;
afterEach(async () => {
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  orgId = null;
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

it('ORG-1 (partial) Given an initially empty avatar and an admin upload before the locked delete, should remove the uploaded file with the deleted org', async () => {
  const owner = await factories.createUser();
  const admin = await factories.createUser();
  userIds.push(owner.id, admin.id);
  const [org] = await db.insert(organizations).values({ name: 'avatar-deletion-race', slug: createId(), ownerId: owner.id }).returning();
  orgId = org.id;
  await db.insert(orgMembers).values([{ orgId: org.id, userId: owner.id, role: 'OWNER' }, { orgId: org.id, userId: admin.id, role: 'ADMIN' }]);
  expect(org.avatarUrl).toBeNull();
  vi.mocked(authenticateRequestWithOptions).mockImplementation(async request => {
    const auth: SessionAuthResult = { userId: new URL(request.url).pathname.endsWith('/avatar') ? admin.id : owner.id, tokenType: 'session', sessionId: createId(), role: 'user', tokenVersion: 0, adminRoleVersion: 0, authentication: { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' } };
    return auth;
  });
  const filename = 'avatar-abc123.png';
  const folder = new Set<string>();
  vi.mocked(callOrgAvatarStorage).mockImplementation(async (_orgId, _token, init) => {
    if (init.method === 'POST') { folder.add(filename); return Response.json({ filename }); }
    if (init.filename) folder.delete(init.filename);
    else folder.clear();
    return Response.json({ success: true });
  });
  let ready!: () => void;
  let resume!: () => void;
  const paused = new Promise<void>(resolve => { ready = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  // Pause after the route's initial avatar decision but before the service's org lock.
  vi.mocked(orgChangeAudience).mockImplementationOnce(async () => { ready(); await resumed; return []; });
  const context = { params: Promise.resolve({ orgId: org.id }) };
  const deletion = DELETE(new Request(`http://app.test/api/orgs/${org.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drives: [] }) }), context);
  await paused;
  try {
    const form = new FormData();
    form.append('file', new File(['test-image'], 'avatar.png', { type: 'image/png' }));
    expect((await POST(new Request(`http://app.test/api/orgs/${org.id}/avatar`, { method: 'POST', body: form }), context)).status).toBe(200);
    expect(folder.has(filename)).toBe(true);
    expect((await db.select().from(organizations).where(eq(organizations.id, org.id)))[0].avatarUrl).toContain(filename);
  } finally { resume(); }
  expect((await deletion).status).toBe(200);
  expect(await db.select().from(organizations).where(eq(organizations.id, org.id))).toEqual([]);
  expect(folder.size).toBe(0);
  expect(callOrgAvatarStorage).toHaveBeenCalledWith(org.id, 'test-org-token', { method: 'DELETE' });
}, 30000);

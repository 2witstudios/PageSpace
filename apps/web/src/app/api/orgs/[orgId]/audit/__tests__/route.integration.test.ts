/**
 * The org audit log end to end (Spec AUD-3) against a REAL Postgres and the REAL security audit chain:
 * events written through recordOrgAuditEvent are read back through the routes, with the real org role
 * lookup deciding who may read. Only the session is faked.
 *
 * Every org and user row is deleted (audit rows stay: they are links in the hash chain).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true })),
  DISTRIBUTED_RATE_LIMITS: { EMAIL_RESEND: 'EMAIL_RESEND', API: 'API' },
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { recordOrgAuditEvent } from '@pagespace/lib/audit/org-audit';
import { GET } from '../route';
import { GET as EXPORT } from '../export/route';

const created = { orgs: [] as string[], users: [] as string[] };
const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 });
const signedInAs = (userId: string) => vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(userId));

async function northwind(name: string) {
  const [owner, admin, member] = await Promise.all(['Jono', 'Priya Nair', 'Marcus Oyelaran'].map((n) => factories.createUser({ name: `${n} ${name}` })));
  created.users.push(owner.id, admin.id, member.id);
  const [org] = await db.insert(organizations).values({ name, slug: `${name.toLowerCase()}-${createId()}`, ownerId: owner.id }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: owner.id, role: 'OWNER' },
    { orgId: org.id, userId: admin.id, role: 'ADMIN' },
    { orgId: org.id, userId: member.id, role: 'MEMBER' },
  ]);
  return { orgId: org.id, owner, admin, member };
}

const get = (orgId: string, query = '') => GET(new Request(`https://example.test/api/orgs/${orgId}/audit${query}`), { params: Promise.resolve({ orgId }) });
const exportCsv = (orgId: string, query = '') => EXPORT(new Request(`https://example.test/api/orgs/${orgId}/audit/export${query}`), { params: Promise.resolve({ orgId }) });

describe('org audit log routes (real Postgres, real chain)', () => {
  let dbAvailable = false;

  beforeAll(async () => {
    try {
      await db.select({ id: organizations.id }).from(organizations).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('audit route.integration.test.ts', error);
    }
    vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    const orgIds = created.orgs.splice(0);
    if (orgIds.length > 0) {
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    const userIds = created.users.splice(0);
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it('AUD-3 the log is filterable by type, drive and time and exports as safe CSV, for the Owner and Admins of the org only', async () => {
    if (!dbAvailable) return;
    const north = await northwind('Northwind');
    const acme = await northwind('Acme');
    const finance = `drive_finance_${createId()}`;
    const t0 = new Date(Date.now() - 1000).toISOString();
    await recordOrgAuditEvent({ orgId: north.orgId, eventType: 'org.policy.changed', actorId: north.owner.id, resourceType: 'organization', resourceId: north.orgId, details: { changes: [{ key: 'guests', from: 'on', to: 'off' }] } });
    await recordOrgAuditEvent({ orgId: north.orgId, driveId: finance, eventType: 'org.drive.visibility_changed', actorId: north.admin.id, resourceType: 'drive', resourceId: finance, details: { from: 'OPEN', to: 'PRIVATE' } });
    await recordOrgAuditEvent({ orgId: north.orgId, eventType: 'org.invite.created', actorId: north.admin.id, resourceType: 'organization_invitation', resourceId: '=HYPERLINK("http://evil")', details: { role: 'MEMBER' } });
    await recordOrgAuditEvent({ orgId: acme.orgId, driveId: finance, eventType: 'org.drive.visibility_changed', actorId: acme.owner.id, resourceType: 'drive', resourceId: finance });

    // Visible to the Owner and Admins.
    signedInAs(north.admin.id);
    const all = await get(north.orgId);
    expect(all.status).toBe(200);
    const body = (await all.json()) as { entries: Array<{ eventType: string; actorName: string | null; driveId: string | null }> };
    expect(body.entries.map((e) => e.eventType)).toEqual(['org.invite.created', 'org.drive.visibility_changed', 'org.policy.changed']);
    expect(body.entries[1]).toMatchObject({ actorName: 'Priya Nair Northwind', driveId: finance });

    // Filterable by type, by drive, and by time.
    const byType = (await (await get(north.orgId, '?type=org.policy.changed')).json()) as { entries: unknown[] };
    expect(byType.entries).toHaveLength(1);
    const byDrive = (await (await get(north.orgId, `?driveId=${finance}`)).json()) as { entries: Array<{ eventType: string }> };
    expect(byDrive.entries.map((e) => e.eventType)).toEqual(['org.drive.visibility_changed']);
    const before = (await (await get(north.orgId, `?to=${encodeURIComponent(t0)}`)).json()) as { entries: unknown[] };
    expect(before.entries).toEqual([]);
    const since = (await (await get(north.orgId, `?from=${encodeURIComponent(t0)}`)).json()) as { entries: unknown[] };
    expect(since.entries).toHaveLength(3);

    // CSV export, formula-neutralized, this org only.
    signedInAs(north.owner.id);
    const csv = await exportCsv(north.orgId);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const text = await csv.text();
    const lines = text.trimEnd().split('\r\n');
    expect(lines[0]).toBe('timestamp,category,event_type,actor_id,actor_name,resource_type,resource_id,drive_id,details');
    expect(lines).toHaveLength(4);
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(text).not.toContain(acme.owner.id);

    // Both roles read both ways: the Owner reads the log, an Admin exports it.
    signedInAs(north.owner.id);
    expect((await get(north.orgId)).status).toBe(200);
    signedInAs(north.admin.id);
    expect((await exportCsv(north.orgId)).status).toBe(200);

    // Not to a plain member, and not across orgs: Northwind's Admin sees no Acme org at all.
    signedInAs(north.member.id);
    expect((await get(north.orgId)).status).toBe(403);
    expect((await exportCsv(north.orgId)).status).toBe(403);
    signedInAs(north.admin.id);
    expect((await get(acme.orgId)).status).toBe(404);
    expect((await exportCsv(acme.orgId, `?driveId=${finance}`)).status).toBe(404);
  });
});

/**
 * The org audit log against the REAL security audit chain (Spec AUD-2, AUD-3): org events written by
 * recordOrgAuditEvent are read back by org, type, category, drive and time, page by keyset, export to CSV in
 * chunks, never cross into another org, and leave the chain verifiable.
 *
 * Audit rows are never deleted (they are links in the hash chain); every org and user row is.
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/audit/__tests__/org-audit-query.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { resetAuditDbBindingForTests } from '../audit-db-binding';
import { resetDefaultSecurityAuditForTests, securityAudit } from '../security-audit';
import { recordOrgAuditEvent } from '../org-audit';
import { parseOrgAuditFilter, type OrgAuditFilter } from '../org-audit-query-core';
import { exportOrgAuditCsv, queryOrgAuditEvents } from '../org-audit-query';
import { verifySecurityAuditChain } from '../security-audit-chain-verifier';

const AUDIT_ENV = ['ADMIN_DATABASE_URL', 'ADMIN_DB_BREAK_GLASS', 'AUDIT_TRUST_PLANE_REQUIRED'] as const;
const savedAuditEnv = new Map<string, string | undefined>();
const resetAuditBinding = () => {
  resetAuditDbBindingForTests();
  resetDefaultSecurityAuditForTests();
};

const created = { orgs: [] as string[], users: [] as string[] };

const filter = (input: Parameters<typeof parseOrgAuditFilter>[0] = {}): OrgAuditFilter => {
  const parsed = parseOrgAuditFilter(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.filter;
};

async function org(name: string) {
  const owner = await factories.createUser({ name: `${name} Owner` });
  const outsider = await factories.createUser({ name: `${name} Outsider` });
  created.users.push(owner.id, outsider.id);
  const [row] = await db.insert(organizations).values({ name, slug: `${name.toLowerCase()}-${createId()}`, ownerId: owner.id }).returning();
  created.orgs.push(row.id);
  await db.insert(orgMembers).values({ orgId: row.id, userId: owner.id, role: 'OWNER' });
  return { orgId: row.id, owner, outsider };
}

describe('org audit log on the real chain', () => {
  let startedAt: Date;

  beforeAll(async () => {
    try {
      await db.select({ id: organizations.id }).from(organizations).limit(1);
    } catch (error) {
      requireDb('org-audit-query.integration.test.ts', error);
    }
    for (const key of AUDIT_ENV) {
      savedAuditEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    resetAuditBinding();
    startedAt = new Date(Date.now() - 1000);
  });

  afterEach(async () => {
    const orgIds = created.orgs.splice(0);
    if (orgIds.length > 0) {
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    const userIds = created.users.splice(0);
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  afterAll(() => {
    for (const [key, value] of savedAuditEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuditBinding();
  });

  it('AUD-2 (partial) AUD-3 (partial) reads one org\'s events by type, category, drive and time, newest first, with member names only', async () => {
    const a = await org('Northwind');
    const b = await org('Acme');
    const finance = `drive_finance_${createId()}`;
    await recordOrgAuditEvent({ orgId: a.orgId, eventType: 'org.policy.changed', actorId: a.owner.id, resourceType: 'organization', resourceId: a.orgId, details: { changes: [{ key: 'guests', from: 'on', to: 'off' }] } });
    await recordOrgAuditEvent({ orgId: a.orgId, driveId: finance, eventType: 'org.drive.visibility_changed', actorId: a.outsider.id, resourceType: 'drive', resourceId: finance, details: { from: 'OPEN', to: 'PRIVATE' } });
    // The ORG-4 row the permissions layer writes when org power opens a PRIVATE drive.
    await securityAudit.logEvent({ eventType: 'authz.access.granted', userId: a.owner.id, resourceType: 'drive', resourceId: finance, details: { via: 'org_admin', orgId: a.orgId, orgRole: 'OWNER', orgVisibility: 'PRIVATE' } });
    // Not org events: a read with an orgId detail, and another org's event.
    await securityAudit.logEvent({ eventType: 'data.read', userId: a.owner.id, resourceType: 'organization_policies', resourceId: a.orgId, details: { orgId: a.orgId } });
    await recordOrgAuditEvent({ orgId: b.orgId, driveId: finance, eventType: 'org.policy.changed', actorId: b.owner.id, resourceType: 'organization', resourceId: b.orgId });

    const all = await queryOrgAuditEvents(a.orgId, filter());
    expect(all.entries.map((e) => e.eventType)).toEqual(['authz.access.granted', 'org.drive.visibility_changed', 'org.policy.changed']);
    expect(all.entries[0]).toMatchObject({ category: 'private_drive_access', driveId: finance, actorId: a.owner.id, actorName: 'Northwind Owner' });
    // The outsider is not a member: an id, never a name.
    expect(all.entries[1]).toMatchObject({ category: 'visibility', driveId: finance, actorId: a.outsider.id, actorName: null, details: { from: 'OPEN', to: 'PRIVATE' } });
    expect(all.entries[2].details).toEqual({ changes: [{ key: 'guests', from: 'on', to: 'off' }] });
    for (const entry of all.entries) expect(entry).not.toHaveProperty('ipAddress');

    expect((await queryOrgAuditEvents(a.orgId, filter({ type: 'org.policy.changed' }))).entries).toHaveLength(1);
    expect((await queryOrgAuditEvents(a.orgId, filter({ category: 'private_drive_access' }))).entries).toHaveLength(1);
    // "Who opened Finance": the drive filter finds both the org event and the access row.
    expect((await queryOrgAuditEvents(a.orgId, filter({ driveId: finance }))).entries.map((e) => e.eventType)).toEqual(['authz.access.granted', 'org.drive.visibility_changed']);
    expect((await queryOrgAuditEvents(a.orgId, filter({ from: new Date(Date.now() + 60_000).toISOString() }))).entries).toEqual([]);
    expect((await queryOrgAuditEvents(a.orgId, filter({ to: startedAt.toISOString() }))).entries).toEqual([]);
  });

  it('AUD-3 (partial) an org never sees another org\'s rows, whatever drive, type or cursor it passes', async () => {
    const a = await org('Northwind');
    const b = await org('Acme');
    const acmeDrive = `drive_acme_${createId()}`;
    await recordOrgAuditEvent({ orgId: b.orgId, driveId: acmeDrive, eventType: 'org.drive.visibility_changed', actorId: b.owner.id, resourceType: 'drive', resourceId: acmeDrive });
    expect((await queryOrgAuditEvents(a.orgId, filter())).entries).toEqual([]);
    expect((await queryOrgAuditEvents(a.orgId, filter({ driveId: acmeDrive }))).entries).toEqual([]);
    expect((await queryOrgAuditEvents(a.orgId, filter({ before: '900000000000000' }))).entries).toEqual([]);
    expect((await queryOrgAuditEvents(b.orgId, filter({ driveId: acmeDrive }))).entries).toHaveLength(1);
  });

  it('AUD-3 (partial) pages by keyset without gaps or repeats, and the CSV export reads in chunks with every value neutralized', async () => {
    const a = await org('Northwind');
    const total = 520; // more than one export chunk (500)
    for (let i = 0; i < total; i++) {
      await recordOrgAuditEvent({ orgId: a.orgId, eventType: 'org.invite.created', actorId: a.owner.id, resourceType: 'organization_invitation', resourceId: i === 0 ? '=HYPERLINK("http://evil")' : `inv_${i}`, details: { n: i } });
    }
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await queryOrgAuditEvents(a.orgId, filter({ limit: '200', ...(before ? { before } : {}) }));
      seen.push(...page.entries.map((e) => String(e.resourceId)));
      if (page.nextCursor === null) break;
      before = String(page.nextCursor);
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);

    const { limit: _l, before: _b, ...exportFilter } = filter();
    const chunks: string[] = [];
    for await (const chunk of exportOrgAuditCsv(a.orgId, exportFilter)) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThanOrEqual(3); // header, then two data chunks
    const lines = chunks.join('').trimEnd().split('\r\n');
    expect(lines[0]).toBe('timestamp,category,event_type,actor_id,actor_name,resource_type,resource_id,drive_id,details');
    expect(lines).toHaveLength(total + 1);
    const evil = lines.find((line) => line.includes('HYPERLINK'));
    expect(evil).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines.some((line) => line.includes(a.orgId))).toBe(false);
  });

  it('AUD-2 (partial) the chain still verifies after org events are written through it', async () => {
    const a = await org('Northwind');
    await recordOrgAuditEvent({ orgId: a.orgId, eventType: 'org.member.role_changed', actorId: a.owner.id, resourceType: 'user', resourceId: a.outsider.id, details: { from: 'MEMBER', to: 'ADMIN' } });
    const result = await verifySecurityAuditChain({ fromTimestamp: startedAt, stopOnFirstBreak: true });
    expect(result.breakPoint).toBeNull();
    expect(result.isValid).toBe(true);
    expect(result.entriesVerified).toBeGreaterThan(0);
  });
});

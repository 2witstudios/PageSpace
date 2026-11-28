/**
 * Organizations & Wallets epic, Wave B1 — schema-level proof of the org core:
 * `organizations`, `org_members`, `org_invitations`, and the org columns on
 * `drives` and `drive_members`. Runs without a database; the constraints are
 * exercised against a real Postgres in
 * `src/__tests__/organizations.integration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { getTableColumns, is, SQL } from 'drizzle-orm';
import * as schemaModule from '../../schema';
import {
  organizations,
  orgMembers,
  orgInvitations,
  orgRole,
  ORG_ROLES,
} from '../organizations';
import { drives, orgDriveVisibility, ORG_DRIVE_VISIBILITIES } from '../core';
import { driveMembers, driveMemberSource, DRIVE_MEMBER_SOURCES } from '../members';

const dialect = new PgDialect();

function foreignKeyOn(table: PgTable, column: string) {
  const fk = getTableConfig(table).foreignKeys.find((f) => f.reference().columns.some((c) => c.name === column));
  if (!fk) throw new Error(`no FK on ${column}`);
  return { onDelete: fk.onDelete, target: getTableConfig(fk.reference().foreignTable).name };
}

function indexNamed(table: PgTable, name: string) {
  const found = getTableConfig(table).indexes.find((i) => i.config.name === name);
  if (!found) throw new Error(`no index named ${name}`);
  return {
    unique: found.config.unique,
    columns: found.config.columns.map((c) => (is(c, SQL) ? dialect.sqlToQuery(c).sql : 'name' in c ? c.name : undefined)),
    where: found.config.where ? dialect.sqlToQuery(found.config.where).sql : undefined,
  };
}

describe('schema barrel enumerates the org tables', () => {
  it('ORG-1 (partial) ORG-2 (partial) ORG-3 (partial) registers organizations, org_members and org_invitations in the combined schema', () => {
    expect(schemaModule.schema.organizations).toBe(organizations);
    expect(schemaModule.schema.orgMembers).toBe(orgMembers);
    expect(schemaModule.schema.orgInvitations).toBe(orgInvitations);
    expect([organizations, orgMembers, orgInvitations].map((t) => getTableConfig(t).name)).toEqual([
      'organizations',
      'org_members',
      'org_invitations',
    ]);
  });
});

describe('organizations', () => {
  const columns = getTableColumns(organizations);

  it('ORG-1 (partial) carries name, a globally unique slug, an avatar and a required owner', () => {
    expect(columns.name.notNull).toBe(true);
    expect(columns.slug.notNull).toBe(true);
    expect(columns.slug.isUnique).toBe(true);
    expect(columns.avatarUrl.notNull).toBe(false);
    expect(columns.ownerId.notNull).toBe(true);
  });

  it('ORG-1 (partial) restricts deleting the owning user — ORG-6 (partial): an Owner cannot delete their account while owning an org', () => {
    expect(foreignKeyOn(organizations, 'ownerId')).toEqual({ onDelete: 'restrict', target: 'users' });
  });

  it('ORG-1 (partial) holds org policies as NOT NULL jsonb defaulting to an empty object', () => {
    expect(columns.policies.dataType).toBe('json');
    expect(columns.policies.notNull).toBe(true);
    expect(columns.policies.hasDefault).toBe(true);
  });

  it('ORG-1 (partial) keeps the Stripe fields nullable (an org exists before it pays)', () => {
    expect(columns.stripeCustomerId.notNull).toBe(false);
    expect(columns.stripeCustomerId.isUnique).toBe(true);
    expect(columns.stripeSubscriptionId.notNull).toBe(false);
  });
});

describe('org_members', () => {
  const columns = getTableColumns(orgMembers);

  it('ORG-2 (partial) exports the closed OrgRole set Owner, Admin, Member', () => {
    expect([...ORG_ROLES]).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
    expect(orgRole.enumValues).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
    expect(columns.role.notNull).toBe(true);
    expect(columns.role.default).toBe('MEMBER');
  });

  it('ORG-2 (partial) allows a user in many orgs but only once per org', () => {
    const unique = getTableConfig(orgMembers).uniqueConstraints.find((u) => u.name === 'org_members_org_user_key');
    expect(unique?.columns.map((c) => c.name)).toEqual(['orgId', 'userId']);
    expect(indexNamed(orgMembers, 'org_members_user_id_idx').columns).toEqual(['userId']);
  });

  it('ORG-1 (partial) an org has exactly one Owner membership row', () => {
    expect(indexNamed(orgMembers, 'org_members_one_owner_key')).toEqual({
      unique: true,
      columns: ['orgId'],
      where: `"org_members"."role" = 'OWNER'`,
    });
  });

  it('ORG-2 (partial) cascades membership rows with the org and with the user', () => {
    expect(foreignKeyOn(orgMembers, 'orgId')).toEqual({ onDelete: 'cascade', target: 'organizations' });
    expect(foreignKeyOn(orgMembers, 'userId')).toEqual({ onDelete: 'cascade', target: 'users' });
  });
});

describe('org_invitations', () => {
  const columns = getTableColumns(orgInvitations);

  it('ORG-3 (partial) stores only a token hash, never the raw token, plus email, role, expiry and acceptance', () => {
    expect(columns).not.toHaveProperty('token');
    expect(columns.tokenHash.notNull).toBe(true);
    expect(columns.tokenHash.isUnique).toBe(true);
    expect(columns.email.notNull).toBe(true);
    expect(columns.role.notNull).toBe(true);
    expect(columns.expiresAt.notNull).toBe(true);
    expect(columns.acceptedAt.notNull).toBe(false);
  });

  it('ORG-3 (partial) allows one open (unaccepted) invite per org and case-insensitive email', () => {
    expect(indexNamed(orgInvitations, 'org_invitations_open_org_email_key')).toEqual({
      unique: true,
      columns: ['orgId', 'lower("org_invitations"."email")'],
      where: '"org_invitations"."acceptedAt" IS NULL',
    });
  });
});

describe('drives org columns', () => {
  const columns = getTableColumns(drives);
  const config = getTableConfig(drives);

  it('DRV-1 (partial) a drive can be owned by an org; deleting an org with drives is refused — ORG-6 (partial) — and never set null', () => {
    expect(columns.orgId.notNull).toBe(false);
    expect(foreignKeyOn(drives, 'orgId')).toEqual({ onDelete: 'restrict', target: 'organizations' });
  });

  it('DRV-1 (partial) Home drives never can: a CHECK refuses orgId on a HOME drive', () => {
    const check = config.checks.find((c) => c.name === 'drives_home_never_org_check');
    expect(check).toBeDefined();
    expect(dialect.sqlToQuery(check!.value).sql).toBe(`"drives"."kind" <> 'HOME' OR "drives"."orgId" IS NULL`);
  });

  it('DRV-4 org visibility is Open, Restricted or Private and defaults to Open', () => {
    expect([...ORG_DRIVE_VISIBILITIES]).toEqual(['OPEN', 'RESTRICTED', 'PRIVATE']);
    expect(orgDriveVisibility.enumValues).toEqual(['OPEN', 'RESTRICTED', 'PRIVATE']);
    expect(columns.orgVisibility.notNull).toBe(true);
    expect(columns.orgVisibility.default).toBe('OPEN');
  });

  it('DRV-1 (partial) drive slugs are unique per org for org drives (D-OW-15)', () => {
    expect(indexNamed(drives, 'drives_org_slug_unique')).toEqual({
      unique: true,
      columns: ['orgId', 'slug'],
      where: '"drives"."orgId" IS NOT NULL',
    });
  });
});

describe('drive_members.source', () => {
  const columns = getTableColumns(driveMembers);

  it('DRV-8 (partial) distinguishes invited members (guests included) from org-materialized rows, defaulting to invite (D-OW-6)', () => {
    expect([...DRIVE_MEMBER_SOURCES]).toEqual(['invite', 'org']);
    expect(driveMemberSource.enumValues).toEqual(['invite', 'org']);
    expect(columns.source.notNull).toBe(true);
    expect(columns.source.default).toBe('invite');
  });
});

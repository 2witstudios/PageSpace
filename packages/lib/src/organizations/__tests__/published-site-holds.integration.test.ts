/**
 * Content-safety site holds against REAL Postgres with an in-memory object store.
 *
 * A held drive's sites are parked under `suspended/` and must stay there: no publish write, no policy change and
 * no reconcile sweep may put them back until the hold is lifted.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { contentSiteHolds } from '@pagespace/db/schema/content-safety';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { driveMembers } from '@pagespace/db/schema/members';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';

import type { PublishedObjectStore } from '../published-visibility-core';
import {
  PublishHeldError,
  PublishHiddenError,
  assertPrefixWritable,
  isPrefixVisible,
  parkDriveSites,
  parkUserSites,
  reconcileAllPublishedVisibility,
  reconcileOrgPublishedVisibility,
  restoreDriveSites,
  restoreUserSites,
} from '../published-visibility';

class MemoryStore implements PublishedObjectStore {
  objects = new Map<string, string>();
  failCopyOn: string | null = null;
  async listKeys(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async listPrefixes(root: string) {
    const names = new Set<string>();
    for (const k of this.objects.keys()) if (k.startsWith(root)) names.add(k.slice(root.length).split('/')[0]);
    return [...names].sort();
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async copy(from: string, to: string) {
    if (this.failCopyOn && from.includes(this.failCopyOn)) throw new Error('store unavailable');
    const body = this.objects.get(from);
    if (body === undefined) throw new Error('NoSuchKey');
    this.objects.set(to, body);
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
}

const run = createId().slice(0, 6).toLowerCase();
const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };
interface World {
  owner: string;
  personalDrive: string;
  personalSite: string;
  personalDomain: string;
  sharedOrgDrive: string;
  sharedOrgSite: string;
  soloOrgDrive: string;
  soloOrgSite: string;
  unpublishedDrive: string;
  orgId: string;
  store: MemoryStore;
}
let w: World;

async function cleanup() {
  if (created.driveIds.length) {
    await db.delete(contentSiteHolds).where(inArray(contentSiteHolds.driveId, created.driveIds));
    await db.delete(drives).where(inArray(drives.id, created.driveIds));
  }
  if (created.orgIds.length) {
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.orgIds = [];
}

beforeEach(async () => {
  const mkUser = async () => {
    const u = await factories.createUser();
    created.userIds.push(u.id);
    return u.id;
  };
  const mkDrive = async (ownerId: string, patch: Partial<typeof drives.$inferInsert>) => {
    const d = await factories.createDrive(ownerId);
    created.driveIds.push(d.id);
    if (Object.keys(patch).length) await db.update(drives).set(patch).where(eq(drives.id, d.id));
    return d.id;
  };
  const owner = await mkUser();
  const colleague = await mkUser();
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `hold-${run}-${createId().slice(0, 4)}`, ownerId: owner });
  await factories.createOrgSubscription(orgId);
  await db.insert(orgMembers).values({ orgId, userId: owner, role: 'OWNER' });

  const tag = createId().slice(0, 5).toLowerCase();
  const personalSite = `me-${run}-${tag}`;
  const personalDomain = `me-${run}-${tag}.example.test`;
  const sharedOrgSite = `team-${run}-${tag}`;
  const soloOrgSite = `solo-${run}-${tag}`;
  const personalDrive = await mkDrive(owner, { publishSubdomain: personalSite });
  await db.insert(customDomains).values({ driveId: personalDrive, hostname: personalDomain });
  const sharedOrgDrive = await mkDrive(owner, { orgId, orgVisibility: 'OPEN', publishSubdomain: sharedOrgSite });
  await db.insert(driveMembers).values({ driveId: sharedOrgDrive, userId: colleague, role: 'MEMBER', acceptedAt: new Date() });
  const soloOrgDrive = await mkDrive(owner, { orgId, orgVisibility: 'OPEN', publishSubdomain: soloOrgSite });
  // Neither of these makes the drive shared: a pending invitation and a guest (a redeemed page link) are not members.
  const invitee = await mkUser();
  const guest = await mkUser();
  await db.insert(driveMembers).values([
    { driveId: soloOrgDrive, userId: invitee, role: 'MEMBER', acceptedAt: null },
    { driveId: soloOrgDrive, userId: guest, role: 'GUEST', acceptedAt: new Date() },
  ]);
  const unpublishedDrive = await mkDrive(owner, {});

  const store = new MemoryStore();
  for (const prefix of [personalSite, personalDomain, sharedOrgSite, soloOrgSite]) {
    store.objects.set(`published/${prefix}/index.html`, `home of ${prefix}`);
    store.objects.set(`published/${prefix}/docs/index.html`, `docs of ${prefix}`);
  }
  w = { owner, personalDrive, personalSite, personalDomain, sharedOrgDrive, sharedOrgSite, soloOrgDrive, soloOrgSite, unpublishedDrive, orgId, store };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const publicKeys = (prefix: string) => [...w.store.objects.keys()].filter((k) => k.startsWith(`published/${prefix}/`));
const parkedKeys = (prefix: string) => [...w.store.objects.keys()].filter((k) => k.startsWith(`suspended/${prefix}/`));

describe('parkDriveSites', () => {
  it('moves the drive subdomain and every custom domain off the public prefix', async () => {
    await parkDriveSites({ driveId: w.personalDrive, source: 'takedown', caseId: 'case-1', createdBy: 'admin-1' }, w.store);

    expect(publicKeys(w.personalSite)).toEqual([]);
    expect(publicKeys(w.personalDomain)).toEqual([]);
    expect(parkedKeys(w.personalSite)).toHaveLength(2);
    expect(parkedKeys(w.personalDomain)).toHaveLength(2);
    expect(publicKeys(w.soloOrgSite)).toHaveLength(2);
  });

  it('refuses every later publish write into the held drive, with a message that gives no reason', async () => {
    await parkDriveSites({ driveId: w.personalDrive, source: 'takedown' }, w.store);

    expect(await isPrefixVisible(w.personalSite)).toBe(false);
    await expect(assertPrefixWritable(w.personalSite)).rejects.toBeInstanceOf(PublishHeldError);
    await expect(assertPrefixWritable(w.personalDomain)).rejects.toBeInstanceOf(PublishHiddenError);
    await expect(assertPrefixWritable(w.personalSite)).rejects.toThrow('Publishing is not available for this site.');
    await expect(assertPrefixWritable(w.soloOrgSite)).resolves.toBeUndefined();
  });

  it('survives the reconcile sweep: a held personal drive is not restored', async () => {
    await parkDriveSites({ driveId: w.personalDrive, source: 'takedown' }, w.store);
    await reconcileAllPublishedVisibility(w.store);

    expect(publicKeys(w.personalSite)).toEqual([]);
    expect(parkedKeys(w.personalSite)).toHaveLength(2);
  });

  it('survives an org policy reconcile that would otherwise make the site visible', async () => {
    await parkDriveSites({ driveId: w.soloOrgDrive, source: 'takedown' }, w.store);
    await reconcileOrgPublishedVisibility(w.orgId, w.store);

    expect(publicKeys(w.soloOrgSite)).toEqual([]);
    expect(publicKeys(w.sharedOrgSite)).toHaveLength(2);
  });

  it('keeps the hold and reports failure when the store fails part-way, and a rerun finishes', async () => {
    w.store.failCopyOn = w.personalDomain;
    await expect(parkDriveSites({ driveId: w.personalDrive, source: 'takedown' }, w.store)).rejects.toThrow(/Could not park/);
    await expect(assertPrefixWritable(w.personalDomain)).rejects.toBeInstanceOf(PublishHeldError);

    w.store.failCopyOn = null;
    await parkDriveSites({ driveId: w.personalDrive, source: 'takedown' }, w.store);
    expect(publicKeys(w.personalDomain)).toEqual([]);
  });

  it('is re-parked by the sweep if a publish slipped an object in after the move', async () => {
    await parkDriveSites({ driveId: w.personalDrive, source: 'takedown' }, w.store);
    // A publish that passed the write guard just before the hold existed lands now.
    w.store.objects.set(`published/${w.personalSite}/late/index.html`, 'late');

    await reconcileAllPublishedVisibility(w.store);

    expect(publicKeys(w.personalSite)).toEqual([]);
    expect(parkedKeys(w.personalSite)).toHaveLength(3);
  });
});

describe('restoreDriveSites', () => {
  it('puts every object back and lifts the hold', async () => {
    await parkDriveSites({ driveId: w.personalDrive, source: 'takedown' }, w.store);
    await restoreDriveSites(w.personalDrive, w.store);

    expect(publicKeys(w.personalSite)).toHaveLength(2);
    expect(publicKeys(w.personalDomain)).toHaveLength(2);
    expect(parkedKeys(w.personalSite)).toEqual([]);
    await expect(assertPrefixWritable(w.personalSite)).resolves.toBeUndefined();
  });
});

describe('parkUserSites', () => {
  it('parks drives the user owns, and reports rather than parks an org drive with other members', async () => {
    const result = await parkUserSites({ userId: w.owner, createdBy: 'admin-1' }, w.store);

    expect(result.parked.map((d) => d.driveId).sort()).toEqual([w.personalDrive, w.soloOrgDrive].sort());
    expect(result.skipped).toEqual([{ driveId: w.sharedOrgDrive, reason: 'org_drive_with_other_members' }]);
    expect(publicKeys(w.personalSite)).toEqual([]);
    expect(publicKeys(w.soloOrgSite)).toEqual([]);
    expect(publicKeys(w.sharedOrgSite)).toHaveLength(2);
  });

  it('still parks an org drive whose only other rows are a pending invitation and a guest', async () => {
    const result = await parkUserSites({ userId: w.owner }, w.store);
    expect(result.parked.map((d) => d.driveId)).toContain(w.soloOrgDrive);
  });

  it('ignores drives that publish nothing', async () => {
    const result = await parkUserSites({ userId: w.owner }, w.store);
    const touched = [...result.parked.map((d) => d.driveId), ...result.skipped.map((d) => d.driveId)];
    expect(touched).not.toContain(w.unpublishedDrive);
  });

  it('is undone by restoreUserSites, which leaves a takedown hold on the same user\'s drive alone', async () => {
    await parkDriveSites({ driveId: w.soloOrgDrive, source: 'takedown', caseId: 'case-9' }, w.store);
    await parkUserSites({ userId: w.owner }, w.store);

    const restored = await restoreUserSites(w.owner, w.store);
    expect(restored.map((d) => d.driveId)).toEqual([w.personalDrive]);
    expect(publicKeys(w.personalSite)).toHaveLength(2);
    expect(publicKeys(w.soloOrgSite)).toEqual([]);
  });

  it('a takedown placed AFTER the suspension takes over the hold, so lifting the suspension does not republish', async () => {
    await parkUserSites({ userId: w.owner }, w.store);
    await parkDriveSites({ driveId: w.personalDrive, source: 'takedown', caseId: 'case-7' }, w.store);

    const restored = await restoreUserSites(w.owner, w.store);

    expect(restored.map((d) => d.driveId)).toEqual([w.soloOrgDrive]);
    expect(publicKeys(w.personalSite)).toEqual([]);
    await expect(assertPrefixWritable(w.personalSite)).rejects.toBeInstanceOf(PublishHeldError);
  });

  it('a suspension placed after a takedown does not relabel the takedown hold', async () => {
    await parkDriveSites({ driveId: w.personalDrive, source: 'takedown', caseId: 'case-7' }, w.store);
    await parkUserSites({ userId: w.owner }, w.store);
    await restoreUserSites(w.owner, w.store);

    expect(publicKeys(w.personalSite)).toEqual([]);
  });
});

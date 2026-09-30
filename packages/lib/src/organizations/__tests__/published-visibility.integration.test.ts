/**
 * Published-site visibility against REAL Postgres with an in-memory object store (Spec POL-4, POL-1, X-6).
 *
 * The published site is static objects in a public bucket, so "paused" has to happen in the bucket: parked
 * objects move to `suspended/`, restore puts every byte back, and no write can re-expose a hidden site.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../../audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}) }));

import { updateOrgPolicies } from '../policies';
import type { PublishedObjectStore } from '../published-visibility-core';
import {
  PublishHiddenError,
  assertPrefixWritable,
  isPrefixVisible,
  listOrgsRestrictingPublishing,
  reconcileAllPublishedVisibility,
  reconcileOrgPublishedVisibility,
  resolvePrefixOwner,
} from '../published-visibility';

class MemoryStore implements PublishedObjectStore {
  objects = new Map<string, string>();
  failListOn: string | null = null;
  async listKeys(prefix: string) {
    if (this.failListOn && prefix.includes(this.failListOn)) throw new Error('store unavailable');
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
interface World { orgId: string; owner: string; site: string; domainHost: string; platformHost: string; personalSite: string; store: MemoryStore }
let w: World;

async function cleanup() {
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.orgIds = [];
}

beforeEach(async () => {
  const mk = async () => {
    const u = await factories.createUser();
    created.userIds.push(u.id);
    return u.id;
  };
  const owner = await mk();
  const other = await mk();
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${run}-${createId().slice(0, 4)}`, ownerId: owner });
  await db.insert(orgMembers).values({ orgId, userId: owner, role: 'OWNER' });
  const orgDrive = await factories.createDrive(owner);
  created.driveIds.push(orgDrive.id);
  const site = `nw-${run}`;
  await db.update(drives).set({ orgId, orgVisibility: 'OPEN', publishSubdomain: site }).where(eq(drives.id, orgDrive.id));
  const domainHost = `docs-${run}.northwind.test`;
  const platformHost = `alias-${run}.pagespace.test`;
  await db.insert(customDomains).values([
    { driveId: orgDrive.id, hostname: domainHost },
    { driveId: orgDrive.id, hostname: platformHost, platformOwned: true },
  ]);
  const personal = await factories.createDrive(other);
  created.driveIds.push(personal.id);
  const personalSite = `me-${run}`;
  await db.update(drives).set({ publishSubdomain: personalSite }).where(eq(drives.id, personal.id));

  const store = new MemoryStore();
  for (const prefix of [site, domainHost, platformHost, personalSite]) {
    store.objects.set(`published/${prefix}/index.html`, `home of ${prefix}`);
    store.objects.set(`published/${prefix}/docs/index.html`, `docs of ${prefix}`);
    store.objects.set(`published/${prefix}/robots.txt`, 'User-agent: *');
  }
  store.objects.set('assets/abc', 'shared asset');
  w = { orgId, owner, site, domainHost, platformHost, personalSite, store };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const set = (patch: Record<string, unknown>) => updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, patch });
const publicKeys = (prefix: string) => [...w.store.objects.keys()].filter((k) => k.startsWith(`published/${prefix}/`));
const parkedKeys = (prefix: string) => [...w.store.objects.keys()].filter((k) => k.startsWith(`suspended/${prefix}/`));

describe('prefix ownership and the write guard', () => {
  it('POL-4 (partial) a prefix resolves to its drive\'s org and kind: subdomain, custom domain, platform alias, or nobody', async () => {
    expect(await resolvePrefixOwner(w.site)).toMatchObject({ orgId: w.orgId, kind: 'site' });
    expect(await resolvePrefixOwner(w.domainHost)).toMatchObject({ orgId: w.orgId, kind: 'domain' });
    expect(await resolvePrefixOwner(w.platformHost)).toMatchObject({ orgId: w.orgId, kind: 'platform_domain' });
    expect(await resolvePrefixOwner(w.personalSite)).toMatchObject({ orgId: null, kind: 'site' });
    expect(await resolvePrefixOwner('nobody-here')).toBeNull();
  });

  it('POL-4 (partial) with publishing OFF a write into the org site or its domains is refused, while a personal drive and an unowned prefix are not', async () => {
    await set({ publishWeb: false });
    await expect(assertPrefixWritable(w.site)).rejects.toBeInstanceOf(PublishHiddenError);
    await expect(assertPrefixWritable(w.domainHost)).rejects.toMatchObject({ code: 'org_policy', statusCode: 403 });
    await expect(assertPrefixWritable(w.platformHost)).rejects.toBeInstanceOf(PublishHiddenError);
    await expect(assertPrefixWritable(w.personalSite)).resolves.toBeUndefined();
    await expect(assertPrefixWritable('nobody-here')).resolves.toBeUndefined();
  });

  it('POL-4 (partial) with only custom domains OFF the org site and the platform alias stay writable; the org\'s own domain does not', async () => {
    await set({ customDomains: false });
    await expect(assertPrefixWritable(w.site)).resolves.toBeUndefined();
    await expect(assertPrefixWritable(w.platformHost)).resolves.toBeUndefined();
    await expect(assertPrefixWritable(w.domainHost)).rejects.toBeInstanceOf(PublishHiddenError);
    expect(await isPrefixVisible(w.domainHost)).toBe(false);
  });

  it('POL-4 (partial) the guard reads the LIVE policy on every call: turning publishing back on lifts it at once', async () => {
    await set({ publishWeb: false });
    await expect(assertPrefixWritable(w.site)).rejects.toBeInstanceOf(PublishHiddenError);
    await set({ publishWeb: true });
    await expect(assertPrefixWritable(w.site)).resolves.toBeUndefined();
  });
});

describe('reconcile', () => {
  it('POL-4 (partial) X-6 (partial) publishing OFF parks every object of the org\'s site and domains, never the personal drive\'s or the shared assets, and deletes nothing', async () => {
    const before = new Map(w.store.objects);
    await set({ publishWeb: false });
    const out = await reconcileOrgPublishedVisibility(w.orgId, w.store);

    expect(out.map((o) => o.action).sort()).toEqual(['parked', 'parked', 'parked']);
    for (const p of [w.site, w.domainHost, w.platformHost]) {
      expect(publicKeys(p)).toEqual([]);
      expect(parkedKeys(p)).toHaveLength(3);
    }
    expect(publicKeys(w.personalSite)).toHaveLength(3);
    expect(w.store.objects.get('assets/abc')).toBe('shared asset');
    // Nothing destroyed: the same bytes exist, now under suspended/.
    expect(w.store.objects.size).toBe(before.size);
    expect(w.store.objects.get(`suspended/${w.site}/docs/index.html`)).toBe(`docs of ${w.site}`);
  });

  it('POL-4 (partial) turning publishing back on restores every object byte for byte at its original key', async () => {
    const before = new Map(w.store.objects);
    await set({ publishWeb: false });
    await reconcileOrgPublishedVisibility(w.orgId, w.store);
    await set({ publishWeb: true });
    const out = await reconcileOrgPublishedVisibility(w.orgId, w.store);

    expect(out.every((o) => o.action === 'restored')).toBe(true);
    expect(w.store.objects).toEqual(before);
  });

  it('POL-4 (partial) only custom domains OFF parks just the org\'s own domain host', async () => {
    await set({ customDomains: false });
    await reconcileOrgPublishedVisibility(w.orgId, w.store);
    expect(parkedKeys(w.domainHost)).toHaveLength(3);
    expect(publicKeys(w.site)).toHaveLength(3);
    expect(publicKeys(w.platformHost)).toHaveLength(3);
  });

  it('POL-4 (partial) re-running with nothing to do changes nothing', async () => {
    await set({ publishWeb: false });
    await reconcileOrgPublishedVisibility(w.orgId, w.store);
    const snapshot = new Map(w.store.objects);
    const again = await reconcileOrgPublishedVisibility(w.orgId, w.store);
    expect(again.every((o) => o.action === 'unchanged')).toBe(true);
    expect(w.store.objects).toEqual(snapshot);
  });

  it('POL-4 (partial) one prefix failing to move does not stop the others and is reported, not thrown', async () => {
    await set({ publishWeb: false });
    w.store.failListOn = w.domainHost;
    const out = await reconcileOrgPublishedVisibility(w.orgId, w.store);
    expect(out.find((o) => o.prefix === w.domainHost)).toMatchObject({ action: 'failed', error: 'store unavailable' });
    expect(parkedKeys(w.site)).toHaveLength(3);
    expect(publicKeys(w.domainHost)).toHaveLength(3);
  });
});

describe('the retry sweep', () => {
  it('POL-4 (partial) a restore that failed after the policy changed is finished by the sweep, which reads the policy, not a marker', async () => {
    await set({ publishWeb: false });
    await reconcileOrgPublishedVisibility(w.orgId, w.store);
    await set({ publishWeb: true });
    // The restore never ran (the store was down): the site is still parked while the policy says visible.
    expect(publicKeys(w.site)).toEqual([]);

    const out = await reconcileAllPublishedVisibility(w.store);

    expect(out.filter((o) => o.action === 'restored').map((o) => o.prefix).sort()).toEqual([w.domainHost, w.platformHost, w.site].sort());
    expect(publicKeys(w.site)).toHaveLength(3);
  });

  it('POL-4 (partial) something that reappeared in a hidden site\'s public prefix is parked again by the sweep', async () => {
    await set({ publishWeb: false });
    await reconcileOrgPublishedVisibility(w.orgId, w.store);
    w.store.objects.set(`published/${w.site}/leaked.html`, 'written by something that bypassed the guard');

    await reconcileAllPublishedVisibility(w.store);

    expect(publicKeys(w.site)).toEqual([]);
    expect(w.store.objects.get(`suspended/${w.site}/leaked.html`)).toBeDefined();
  });

  it('POL-4 (partial) restore keeps a NEWER public object rather than resurrecting the parked one over it', async () => {
    await set({ publishWeb: false });
    await reconcileOrgPublishedVisibility(w.orgId, w.store);
    await set({ publishWeb: true });
    w.store.objects.set(`published/${w.site}/index.html`, 'newer home');
    await reconcileOrgPublishedVisibility(w.orgId, w.store);
    expect(w.store.objects.get(`published/${w.site}/index.html`)).toBe('newer home');
    expect(parkedKeys(w.site)).toEqual([]);
  });

  it('POL-4 (partial) only orgs that actually restrict publishing are listed, including a damaged stored value (which fails closed)', async () => {
    expect(await listOrgsRestrictingPublishing()).not.toContain(w.orgId);
    await set({ publishWeb: true });
    expect(await listOrgsRestrictingPublishing()).not.toContain(w.orgId);
    await set({ publishWeb: false });
    expect(await listOrgsRestrictingPublishing()).toContain(w.orgId);
    await db.update(organizations).set({ policies: { publishWeb: 'garbage' } }).where(eq(organizations.id, w.orgId));
    expect(await listOrgsRestrictingPublishing()).toContain(w.orgId);
  });
});

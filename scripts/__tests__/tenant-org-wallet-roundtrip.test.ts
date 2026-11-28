/**
 * Spec X-3 for the TENANT migration path: an org drive must arrive as an org
 * drive, with its org, its people's memberships and its money — not as a
 * personal drive with the balances dropped.
 *
 * Export → wipe → import against a real Postgres, then every org and wallet
 * table is compared ROW FOR ROW with what was there before. The world is
 * seeded away from column defaults wherever it matters (a LAPSED org, a wallet
 * carrying DEBT in the "over" state, a donation leg, non-default policies), so
 * an equal row means the value travelled rather than that a default agreed.
 *
 * A second org, Contoso, is reachable only because a migrating user is a guest
 * in one of its drives and its Owner stays behind. It must travel as a
 * referenced org — identity, policies, membership — and never with its money,
 * its invitations or its domains (scripts/lib/org-wallet-selection.ts).
 *
 * @integration - requires running postgres (DATABASE_URL)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import { sql } from 'drizzle-orm';
import {
  createTestDb,
  runMigrations,
  truncateAll,
  seedFixtures,
  closePool,
  FIXTURES,
  getTestDatabaseUrl,
  type TestDb,
} from './setup';
import { exportData } from '../tenant-export';
import { runImport } from '../tenant-import';
import { validateData } from '../tenant-validate';
import type { DbClient, ExportManifest } from '../lib/migration-types';
import { db as libDb, pool as libPool } from '@pagespace/db/db';
import { deriveOrgStatus } from '../../packages/lib/src/organizations/status-core';
import { isBillingEnabled } from '../../packages/lib/src/deployment-mode';
import { decideAutoJoin } from '../../packages/lib/src/organizations/domains-core';
import {
  departureSuppressionHash,
  isDepartureSuppressed,
} from '../../packages/lib/src/organizations/departure-suppression';

const { owner, member, outsider } = FIXTURES.users;
const DRIVE = FIXTURES.drives.shared.id;
const NW = 'test_org_northwind_001';
const CONTOSO = 'test_org_contoso_002';
const CONTOSO_DRIVE = 'test_drive_contoso_002';
const POOL = 'test_wallet_nw_pool_001';
const DRIVE_WALLET = 'test_wallet_nw_drive_002';
const OWNER_ROOT = 'test_wallet_owner_root_003';
const MEMBER_ROOT = 'test_wallet_member_root_004';
const CONTOSO_POOL = 'test_wallet_contoso_pool_005';
const OUTSIDER_ROOT = 'test_wallet_outsider_root_006';
/** Someone who left Contoso; only a keyed hash of the address is stored (D-OW-27). */
const CONTOSO_LEAVER = 'leaver@contoso.test';

let db: TestDb;
let tmpDir: string;

async function seedOrgWorld(): Promise<void> {
  const t = new Date('2026-09-01T10:00:00.000Z');
  await db.execute(sql`
    INSERT INTO organizations (id, name, slug, "ownerId", policies, "stripeCustomerId", "stripeSubscriptionId", "seatAutoAdd", "createdAt", "updatedAt")
    VALUES
      (${NW}, 'Northwind', 'northwind', ${owner.id}, ${JSON.stringify({ guests: 'approve', publicShareLinks: 'off' })}::jsonb, 'cus_nw', 'sub_nw', TRUE, ${t}, ${t}),
      (${CONTOSO}, 'Contoso', 'contoso', ${outsider.id}, ${JSON.stringify({ guests: 'on' })}::jsonb, 'cus_contoso', 'sub_contoso', FALSE, ${t}, ${t})
  `);
  await db.execute(sql`
    INSERT INTO org_members (id, "orgId", "userId", role, "invitedBy", "joinedAt") VALUES
      ('test_om_nw_owner', ${NW}, ${owner.id}, 'OWNER', NULL, ${t}),
      ('test_om_nw_member', ${NW}, ${member.id}, 'MEMBER', ${owner.id}, ${t}),
      ('test_om_contoso_owner', ${CONTOSO}, ${outsider.id}, 'OWNER', NULL, ${t})
  `);
  // The team drive becomes a RESTRICTED Northwind drive; Contoso's drive holds the member as a guest.
  await db.execute(sql`UPDATE drives SET "orgId" = ${NW}, "orgVisibility" = 'RESTRICTED' WHERE id = ${DRIVE}`);
  await db.execute(sql`
    INSERT INTO drives (id, name, slug, "ownerId", "orgId", "orgVisibility", "createdAt", "updatedAt")
    VALUES (${CONTOSO_DRIVE}, 'Contoso Plans', 'contoso-plans', ${outsider.id}, ${CONTOSO}, 'PRIVATE', ${t}, ${t})
  `);
  await db.execute(sql`
    INSERT INTO drive_members (id, "driveId", "userId", role, source, "invitedAt", "acceptedAt")
    VALUES ('test_dm_contoso_guest', ${CONTOSO_DRIVE}, ${member.id}, 'MEMBER', 'invite', ${t}, ${t})
  `);
  await db.execute(sql`
    INSERT INTO org_invitations (id, "orgId", email, role, "tokenHash", "invitedBy", "expiresAt", "createdAt") VALUES
      ('test_inv_nw', ${NW}, 'carol@test.local', 'ADMIN', 'hash_inv_nw', ${owner.id}, ${new Date('2026-12-01T00:00:00.000Z')}, ${t}),
      ('test_inv_contoso', ${CONTOSO}, 'dave@test.local', 'MEMBER', 'hash_inv_contoso', ${outsider.id}, ${new Date('2026-12-01T00:00:00.000Z')}, ${t})
  `);
  // LAPSED: the payment failed (SEAT-9). Funding proof for the period it was paid.
  await db.execute(sql`
    INSERT INTO org_subscriptions (id, "orgId", "stripeSubscriptionId", "stripeBasePriceId", "stripeBaseItemId", "stripeSeatPriceId", "stripeSeatItemId", "extraSeatQuantity", "seatRevision", status, "currentPeriodStart", "currentPeriodEnd", "createdAt", "updatedAt") VALUES
      ('test_osub_nw', ${NW}, 'sub_nw', 'price_base', 'si_base', 'price_seat', 'si_seat', 3, 5, 'past_due', ${t}, ${new Date('2026-10-01T10:00:00.000Z')}, ${t}, ${t}),
      ('test_osub_contoso', ${CONTOSO}, 'sub_contoso', 'price_base', 'si_base_c', 'price_seat', 'si_seat_c', 0, 0, 'active', ${t}, ${t}, ${t}, ${t})
  `);
  await db.execute(sql`
    INSERT INTO org_subscription_funding (id, "orgId", "stripeSubscriptionId", "stripeInvoiceId", basis, "paidCents", "verifiedAt")
    VALUES ('test_ofund_nw', ${NW}, 'sub_nw', 'in_nw_1', 'paid', 4900, ${t})
  `);
  await db.execute(sql`
    INSERT INTO org_domains (id, "orgId", domain, "dnsToken", "verifiedAt", "verifiedMethod", "createdBy", "createdAt") VALUES
      ('test_odom_nw', ${NW}, 'northwind.test', 'dns_nw', ${t}, 'dns', ${owner.id}, ${t}),
      ('test_odom_contoso', ${CONTOSO}, 'contoso.test', 'dns_c', ${t}, 'dns', ${outsider.id}, ${t})
  `);
  await db.execute(sql`
    INSERT INTO org_member_departures (id, "orgId", "userId", reason, "departedAt")
    VALUES ('test_odep_nw', ${NW}, ${member.id}, 'left', ${t})
  `);
  const leaverHash = departureSuppressionHash(CONTOSO_LEAVER);
  if (leaverHash === null) throw new Error('no blind-index key: set ENCRYPTION_KEY');
  await db.execute(sql`
    INSERT INTO org_departure_suppressions (id, "orgId", "emailHash", "createdAt") VALUES
      ('test_osup_nw', ${NW}, 'hmac_departed_address', ${t}),
      ('test_osup_contoso', ${CONTOSO}, ${leaverHash}, ${t})
  `);
  await db.execute(sql`
    INSERT INTO org_guest_holds (id, "orgId", "driveId", "userId", email, state, origin, request, "requestedBy", "createdAt")
    VALUES ('test_hold_nw', ${NW}, ${DRIVE}, NULL, 'guest@else.test', 'pending_approval', 'invite', ${JSON.stringify({ role: 'MEMBER' })}::jsonb, ${owner.id}, ${t})
  `);
  await db.execute(sql`
    INSERT INTO drive_join_requests (id, "driveId", "userId", status, message, "requestedAt", "decidedAt", "decidedBy")
    VALUES ('test_djr_nw', ${DRIVE}, ${member.id}, 'approved', 'let me in', ${t}, ${t}, ${owner.id})
  `);
  // Money. The drive wallet is OVER and carries debt; its top-up equals its legs (D-OW-13).
  await db.execute(sql`
    INSERT INTO wallets (id, "ownerType", "userId", "orgId", "subjectType", "subjectId", "parentWalletId", "monthlyRemainingCents", "monthlyAllowanceCents", "spentCents", "topupRemainingCents", "debtCents", "pendingMillicents", status, "donationsEnabled", "fallbackRule", "overshootChoice", "monthlyPeriodStart", "monthlyPeriodEnd", "createdAt", "updatedAt") VALUES
      (${POOL}, 'org', NULL, ${NW}, NULL, NULL, NULL, 400000, 500000, 100000, 0, 0, 0, 'active', TRUE, NULL, NULL, ${t}, ${t}, ${t}, ${t}),
      (${DRIVE_WALLET}, 'org', NULL, ${NW}, 'drive', ${DRIVE}, ${POOL}, 0, 2000, 2250, 300, 250, 417, 'over', FALSE, 'seat_allowance', 'wallet_debt', ${t}, ${t}, ${t}, ${t}),
      (${OWNER_ROOT}, 'user', ${owner.id}, NULL, NULL, NULL, NULL, 1500, 1500, 0, 900, 0, 0, 'active', TRUE, NULL, NULL, ${t}, ${t}, ${t}, ${t}),
      (${MEMBER_ROOT}, 'user', ${member.id}, NULL, NULL, NULL, NULL, 0, 1500, 1600, 0, 100, 0, 'over', TRUE, NULL, NULL, ${t}, ${t}, ${t}, ${t}),
      (${CONTOSO_POOL}, 'org', NULL, ${CONTOSO}, NULL, NULL, NULL, 999999, 999999, 0, 0, 0, 0, 'active', TRUE, NULL, NULL, ${t}, ${t}, ${t}, ${t}),
      (${OUTSIDER_ROOT}, 'user', ${outsider.id}, NULL, NULL, NULL, NULL, 777, 777, 0, 0, 0, 0, 'active', TRUE, NULL, NULL, ${t}, ${t}, ${t}, ${t})
  `);
  await db.execute(sql`
    INSERT INTO wallet_funding_legs (id, "walletId", "funderKind", "funderUserId", "funderOrgId", "originalCents", "remainingCents", "includedCents", "nonRefundable", "sourceRef", "createdAt") VALUES
      ('test_leg_donation', ${DRIVE_WALLET}, 'donation', ${member.id}, NULL, 500, 200, 150, TRUE, 'donation-ref-1', ${t}),
      ('test_leg_owner', ${DRIVE_WALLET}, 'owner', NULL, ${NW}, 100, 100, 0, FALSE, 'topup-ref-1', ${t})
  `);
  await db.execute(sql`
    INSERT INTO wallet_consumer_caps ("walletId", "consumerKey", "dailyCapCents", "monthlyCapCents", "createdAt", "updatedAt")
    VALUES (${POOL}, ${`user:${member.id}`}, 500, 3000, ${t}, ${t})
  `);
  await db.execute(sql`INSERT INTO wallet_debt_notices ("walletId", "lastNotifiedAt") VALUES (${DRIVE_WALLET}, ${t})`);
  await db.execute(sql`
    INSERT INTO wallet_cap_alerts ("walletId", "consumerKey", "capWindow", "periodStart", threshold, "sentAt")
    VALUES (${POOL}, ${`user:${member.id}`}, 'monthly', ${t}, 80, ${t})
  `);
  await db.execute(sql`INSERT INTO drive_spend_overrides ("userId", "driveId", "createdAt") VALUES (${member.id}, ${DRIVE}, ${t})`);
  await db.execute(sql`INSERT INTO automation_skip_notices ("driveId", "lastNotifiedAt") VALUES (${DRIVE}, ${t})`);
  // SPEND-3: the conversation's chosen wallet is a carried wallet, so the choice travels with it.
  await db.execute(sql`UPDATE conversations SET "chosenWalletId" = ${DRIVE_WALLET} WHERE id = ${FIXTURES.conversations.pageChat.id}`);
}

/** Every org/wallet row a bundle must carry, as Postgres returns it, in a fixed order. */
const CARRIED: Record<string, string> = {
  organizations: `SELECT * FROM organizations ORDER BY id`,
  drives: `SELECT id, "ownerId", "orgId", "orgVisibility" FROM drives ORDER BY id`,
  org_members: `SELECT * FROM org_members ORDER BY id`,
  org_invitations: `SELECT * FROM org_invitations WHERE "orgId" = '${NW}' ORDER BY id`,
  org_subscriptions: `SELECT * FROM org_subscriptions WHERE "orgId" = '${NW}' ORDER BY id`,
  org_subscription_funding: `SELECT * FROM org_subscription_funding ORDER BY id`,
  org_domains: `SELECT * FROM org_domains WHERE "orgId" = '${NW}' ORDER BY id`,
  org_member_departures: `SELECT * FROM org_member_departures ORDER BY id`,
  org_departure_suppressions: `SELECT * FROM org_departure_suppressions ORDER BY id`,
  org_guest_holds: `SELECT * FROM org_guest_holds ORDER BY id`,
  drive_join_requests: `SELECT * FROM drive_join_requests ORDER BY id`,
  wallets: `SELECT * FROM wallets WHERE id IN ('${POOL}', '${DRIVE_WALLET}', '${OWNER_ROOT}', '${MEMBER_ROOT}') ORDER BY id`,
  wallet_funding_legs: `SELECT * FROM wallet_funding_legs ORDER BY id`,
  wallet_consumer_caps: `SELECT * FROM wallet_consumer_caps ORDER BY "walletId", "consumerKey"`,
  wallet_debt_notices: `SELECT * FROM wallet_debt_notices ORDER BY "walletId"`,
  wallet_cap_alerts: `SELECT * FROM wallet_cap_alerts ORDER BY "walletId", "consumerKey"`,
  drive_spend_overrides: `SELECT * FROM drive_spend_overrides ORDER BY "userId", "driveId"`,
  automation_skip_notices: `SELECT * FROM automation_skip_notices ORDER BY "driveId"`,
  conversations: `SELECT id, "chosenWalletId" FROM conversations ORDER BY id`,
};

async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [table, query] of Object.entries(CARRIED)) {
    out[table] = (await db.execute(sql.raw(query))).rows;
  }
  return out;
}

async function count(query: string): Promise<number> {
  const { rows } = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${query}`));
  return (rows[0] as { n: number }).n;
}

beforeAll(async () => {
  // The suppression hash is keyed under the deployment's blind-index key, which the tenant shares.
  if ((process.env.ENCRYPTION_KEY ?? '').length < 32) process.env.ENCRYPTION_KEY = 'tenant-roundtrip-test-key-'.padEnd(64, 'k');
  db = createTestDb();
  await runMigrations(db);
});

afterAll(async () => {
  await closePool();
  await libPool.end();
});

let before: Record<string, unknown[]>;
let manifest: ExportManifest;

beforeEach(async () => {
  await truncateAll(db);
  await seedFixtures(db);
  await seedOrgWorld();
  before = await snapshot();

  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pagespace-org-roundtrip-'));
  const sourceFiles = path.join(tmpDir, 'source-files');
  await mkdir(sourceFiles, { recursive: true });
  ({ manifest } = await exportData(db as unknown as DbClient, {
    userIds: [owner.id, member.id],
    outputDir: path.join(tmpDir, 'bundle'),
    fileStoragePath: sourceFiles,
    databaseUrl: getTestDatabaseUrl(),
    dryRun: false,
  }));
  await truncateAll(db);
  expect(await count('organizations')).toBe(0);
});

async function importBundle(): Promise<void> {
  const targetFiles = path.join(tmpDir, 'target-files');
  await mkdir(targetFiles, { recursive: true });
  await runImport({
    bundleDir: path.join(tmpDir, 'bundle'),
    databaseUrl: getTestDatabaseUrl(),
    fileStoragePath: targetFiles,
    dryRun: false,
  });
}

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('X-3 tenant export/import round-trip of organizations and wallets (real PG)', () => {
  beforeEach(importBundle);

  it('X-3 a tenant export/import round-trip keeps an org drive\'s orgId and visibility, org membership, policies and wallet balances, row for row', async () => {
    const after = await snapshot();
    for (const table of Object.keys(CARRIED)) {
      expect(after[table], `${table} differs after export → wipe → import`).toEqual(before[table]);
    }
    // Spot-check the facts the spec names, so a both-sides-empty table cannot pass for a carried one.
    expect(after.drives).toContainEqual({ id: DRIVE, ownerId: owner.id, orgId: NW, orgVisibility: 'RESTRICTED' });
    expect(after.wallets).toContainEqual(expect.objectContaining({ id: DRIVE_WALLET, debtCents: 250, status: 'over', topupRemainingCents: 300 }));
    expect(after.wallet_funding_legs).toContainEqual(expect.objectContaining({ funderKind: 'donation', funderUserId: member.id, remainingCents: 200, includedCents: 150 }));
    expect(after.conversations).toEqual([{ id: FIXTURES.conversations.pageChat.id, chosenWalletId: DRIVE_WALLET }]);
  });

  it('X-3 subscription and funding proof travel unchanged, and on a tenant (billing off) they gate nothing: the lapsed org reads active', async () => {
    // The rows are identical (the row-for-row test above). What they MEAN on a tenant is different:
    // tenant mode runs with billing off, so org status, wallet balances, debt and caps are carried as
    // data and enforced by nothing — the same org that is lapsed on the source reads active here.
    const { rows } = await db.execute(sql.raw(`SELECT * FROM org_subscriptions WHERE "orgId" = '${NW}'`));
    expect(rows).toEqual(before.org_subscriptions);
    const sub = rows[0] as { status: string; collectionMethod: string; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean };
    const subscription = { ...sub, hasVerifiedFunding: (await count(`org_subscription_funding WHERE "orgId" = '${NW}'`)) > 0 };

    const mode = process.env.DEPLOYMENT_MODE;
    process.env.DEPLOYMENT_MODE = 'tenant';
    try {
      expect(isBillingEnabled()).toBe(false);
      expect(deriveOrgStatus({ billingEnabled: isBillingEnabled(), subscription })).toEqual({ status: 'active', reason: null });
    } finally {
      if (mode === undefined) delete process.env.DEPLOYMENT_MODE;
      else process.env.DEPLOYMENT_MODE = mode;
    }
    // On the billed source the identical rows read lapsed — so the data, not its meaning, is what travels.
    expect(deriveOrgStatus({ billingEnabled: true, subscription })).toEqual({ status: 'lapsed', reason: 'payment_failed' });
  });

  it('X-3 a referenced org\'s departure suppressions travel, so an address that left it is never auto-joined on the tenant', async () => {
    // On the tenant the referenced org reads ACTIVE (billing off), and an Admin there can re-add and
    // verify a domain. The suppression is then the only thing standing between a departed person and an
    // automatic re-join, so it travels for every carried org (scripts/lib/org-wallet-selection.ts).
    expect(await isDepartureSuppressed(libDb, CONTOSO, CONTOSO_LEAVER)).toBe(true);
    expect(await isDepartureSuppressed(libDb, CONTOSO, 'newcomer@contoso.test')).toBe(false);

    const joinOnTenant = async (email: string) => decideAutoJoin({
      emailVerified: true,
      userCreatedAt: new Date('2026-11-02T00:00:00.000Z'),
      // A domain the tenant's Admin re-added and verified after the move.
      domainVerifiedAt: new Date('2026-11-01T00:00:00.000Z'),
      isMember: false,
      previouslyDeparted: false,
      departureSuppressed: await isDepartureSuppressed(libDb, CONTOSO, email),
      hasOpenInvite: false,
      isOrgGuest: false,
      orgActive: true,
    });
    expect(await joinOnTenant(CONTOSO_LEAVER)).toEqual({ action: 'skip', reason: 'departure_suppressed' });
    expect(await joinOnTenant('newcomer@contoso.test')).toEqual({ action: 'join' });
  });

  it('X-3 an org reached only through a guest drive travels as identity and membership, never with its money, invitations or domains (its suppressions do travel)', async () => {
    expect(await count(`organizations WHERE id = '${CONTOSO}'`)).toBe(1);
    expect(await count(`drives WHERE id = '${CONTOSO_DRIVE}' AND "orgId" = '${CONTOSO}'`)).toBe(1);
    expect(await count(`wallets WHERE "orgId" = '${CONTOSO}'`)).toBe(0);
    expect(await count(`org_subscriptions WHERE "orgId" = '${CONTOSO}'`)).toBe(0);
    expect(await count(`org_invitations WHERE "orgId" = '${CONTOSO}'`)).toBe(0);
    expect(await count(`org_domains WHERE "orgId" = '${CONTOSO}'`)).toBe(0);
    // Its departure suppressions DO travel: keyed hashes, no address, and they only ever refuse.
    expect(await count(`org_departure_suppressions WHERE "orgId" = '${CONTOSO}'`)).toBe(1);
    // Its Owner is carried as a row (organizations.ownerId and drives.ownerId resolve)…
    expect(await count(`users WHERE id = '${outsider.id}'`)).toBe(1);
    // …but stays live on the source, so their personal balance is not duplicated.
    expect(await count(`wallets WHERE id = '${OUTSIDER_ROOT}'`)).toBe(0);
  });

  it('X-3 tenant-validate asks the export\'s question: it compares every org and wallet table, and counts exactly what the bundle carried', async () => {
    // The imported database holds exactly the bundle, so a validator scoped by the exporter's own
    // rule (org-wallet-selection.ts) must count the manifest's rows — no more (a wider question
    // fails a correct migration), no fewer (a narrower one passes a broken one).
    const result = await validateData(db as unknown as DbClient, db as unknown as DbClient, {
      sourceDatabaseUrl: getTestDatabaseUrl(),
      targetDatabaseUrl: getTestDatabaseUrl(),
      userIds: [owner.id, member.id],
      sourceFileStoragePath: path.join(tmpDir, 'source-files'),
      targetFileStoragePath: path.join(tmpDir, 'target-files'),
    });
    const counts = manifest.tableCounts as Record<string, number>;
    for (const table of Object.keys(CARRIED).filter((t) => t !== 'drives' && t !== 'conversations')) {
      const compared = result.tableResults.find((r) => r.table === table);
      const key = table.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      expect({ table, count: compared?.sourceCount, passed: compared?.passed }).toEqual({ table, count: counts[key], passed: true });
    }
    expect(counts.wallets).toBe(4);
  });
});

/**
 * A destination that already holds a row colliding with the bundle on a SECONDARY unique key (not the
 * primary key, which is how a re-imported bundle stays a no-op). Every org and wallet table names its
 * primary key as the only forgiven conflict, so each of these aborts the one BEGIN/COMMIT and nothing of
 * the bundle lands — never a silently skipped row (a skipped funding leg would break D-OW-13's
 * top-up == SUM(legs), a skipped org would orphan its drives).
 */
describe('X-3 a tenant import that collides on an org or wallet unique key aborts whole (real PG)', () => {
  const COLLIDER = 'test_user_collider_009';
  const COLLIDER_ORG = 'test_org_collider_009';
  const COLLIDER_WALLET = 'test_wallet_collider_009';
  const t = new Date('2026-08-01T00:00:00.000Z');

  async function seedCollider(): Promise<void> {
    await db.execute(sql`
      INSERT INTO users (id, name, email, provider, "createdAt", "updatedAt")
      VALUES (${COLLIDER}, 'Collider', 'collider@test.local', 'email', ${t}, ${t})
    `);
    await db.execute(sql`
      INSERT INTO organizations (id, name, slug, "ownerId", "createdAt", "updatedAt")
      VALUES (${COLLIDER_ORG}, 'Collider Org', 'collider-org', ${COLLIDER}, ${t}, ${t})
    `);
    await db.execute(sql`
      INSERT INTO wallets (id, "ownerType", "userId") VALUES (${COLLIDER_WALLET}, 'user', ${COLLIDER})
    `);
  }

  const collisions: Array<[string, string, () => Promise<unknown>]> = [
    ['an org slug', 'organizations_slug_unique', () => db.execute(sql`UPDATE organizations SET slug = 'northwind' WHERE id = ${COLLIDER_ORG}`)],
    ['a personal root wallet', 'wallets_personal_root_unique', async () => {
      await db.execute(sql`INSERT INTO users (id, name, email, provider, "createdAt", "updatedAt") VALUES (${owner.id}, 'Already here', 'already@test.local', 'email', ${t}, ${t})`);
      await db.execute(sql`INSERT INTO wallets (id, "ownerType", "userId") VALUES ('test_wallet_preexisting_root', 'user', ${owner.id})`);
    }],
    ['a funding leg sourceRef', 'wallet_funding_legs_source_ref_unique', () => db.execute(sql`
      INSERT INTO wallet_funding_legs (id, "walletId", "funderKind", "funderUserId", "originalCents", "remainingCents", "nonRefundable", "sourceRef")
      VALUES ('test_leg_collider', ${COLLIDER_WALLET}, 'owner', ${COLLIDER}, 100, 100, FALSE, 'donation-ref-1')
    `)],
    ['a Stripe subscription id', 'org_subscriptions_stripeSubscriptionId_unique', () => db.execute(sql`
      INSERT INTO org_subscriptions (id, "orgId", "stripeSubscriptionId", "stripeBasePriceId", "stripeBaseItemId", "stripeSeatPriceId", "stripeSeatItemId", status)
      VALUES ('test_osub_collider', ${COLLIDER_ORG}, 'sub_nw', 'p', 'i', 'p', 'i', 'active')
    `)],
    ['a verified domain', 'org_domains_verified_domain_key', () => db.execute(sql`
      INSERT INTO org_domains (id, "orgId", domain, "dnsToken", "verifiedAt", "verifiedMethod")
      VALUES ('test_odom_collider', ${COLLIDER_ORG}, 'northwind.test', 'dns_x', ${t}, 'dns')
    `)],
    ['an invitation token hash', 'org_invitations_tokenHash_unique', () => db.execute(sql`
      INSERT INTO org_invitations (id, "orgId", email, "tokenHash", "expiresAt")
      VALUES ('test_inv_collider', ${COLLIDER_ORG}, 'x@test.local', 'hash_inv_nw', ${new Date('2026-12-01T00:00:00.000Z')})
    `)],
  ];

  it.each(collisions)('X-3 a destination already holding %s fails the import on %s and lands nothing', async (_label, constraint, collide) => {
    await seedCollider();
    await collide();
    const users = await count('users');

    await expect(importBundle()).rejects.toThrow(constraint);

    expect(await count(`organizations WHERE id IN ('${NW}', '${CONTOSO}')`)).toBe(0);
    expect(await count(`drives`)).toBe(0);
    expect(await count(`wallets WHERE id IN ('${POOL}', '${DRIVE_WALLET}', '${OWNER_ROOT}', '${MEMBER_ROOT}')`)).toBe(0);
    expect(await count(`wallet_funding_legs WHERE id IN ('test_leg_donation', 'test_leg_owner')`)).toBe(0);
    expect(await count('users')).toBe(users);
  });
});

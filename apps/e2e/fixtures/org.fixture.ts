import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { organizations, orgInvitations, orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import { wallets } from '@pagespace/db/schema/wallets';
import { NORTHWIND_ORG } from './northwind';

/**
 * Organizations seeded straight into Postgres for the org browser specs (30-34).
 *
 * The app cannot make these rows in the e2e job: creating an org takes a Stripe card checkout
 * (D-OW-30) and the job has no Stripe, and an org drive made through the app writes a first page
 * version to object storage, which the job does not have either. So the specs seed the rows the
 * product's own writers would have left — the org, its member rows, its subscription mirror, its
 * drives with their materialized org members — and then drive everything ELSE through the
 * browser. The shapes mirror the lib integration fixtures (seat-9-matrix, drive-wallet-service).
 *
 * Paid vs lapsed is the subscription mirror (lib organizations/status-core deriveOrgStatus):
 * `paid` is an active, automatically collected subscription with verified funding (the factory's
 * createOrgSubscription); `never_paid` is no subscription row at all (no org trial, D-OW-30);
 * `canceled` is a funded subscription Stripe has since canceled.
 */

export type OrgBilling = 'paid' | 'never_paid' | 'canceled' | 'unpaid' | 'past_due';

export interface SeededOrg {
  orgId: string;
  name: string;
}

/** A unique name per seed: the e2e database accumulates runs, and specs find orgs by name. */
export function orgName(base: string = NORTHWIND_ORG.name): string {
  return `${base} ${createId().slice(0, 6)}`;
}

export async function seedOrg(opts: {
  name: string;
  ownerId: string;
  /** Everyone but the Owner, with their role. */
  members?: readonly { userId: string; role: Exclude<OrgRole, 'OWNER'> }[];
  billing?: OrgBilling;
}): Promise<SeededOrg> {
  const [org] = await db
    .insert(organizations)
    .values({ name: opts.name, slug: `${NORTHWIND_ORG.slug}-${createId()}`, ownerId: opts.ownerId })
    .returning({ id: organizations.id });
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: opts.ownerId, role: 'OWNER' },
    ...(opts.members ?? []).map((m) => ({ orgId: org.id, userId: m.userId, role: m.role })),
  ]);
  const billing = opts.billing ?? 'paid';
  if (billing === 'paid') await factories.createOrgSubscription(org.id);
  if (billing !== 'paid' && billing !== 'never_paid') await factories.createOrgSubscription(org.id, { status: billing });
  return { orgId: org.id, name: opts.name };
}

/**
 * An org drive led by `leadId`, with the drive_members rows the org membership sync materializes:
 * every org member on an Open drive (source 'org'), nobody on a Restricted or Private one.
 */
export async function seedOrgDrive(opts: {
  orgId: string;
  leadId: string;
  name: string;
  visibility: OrgDriveVisibility;
  /** Org members other than the lead; materialized only when the drive is Open. */
  orgMemberIds?: readonly string[];
}): Promise<string> {
  const drive = await factories.createDrive(opts.leadId, {
    name: opts.name,
    slug: `${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${createId().slice(0, 8)}`,
    orgId: opts.orgId,
    orgVisibility: opts.visibility,
  });
  if (opts.visibility === 'OPEN') {
    for (const userId of opts.orgMemberIds ?? []) {
      if (userId !== opts.leadId) await factories.createDriveMember(drive.id, userId, { source: 'org' });
    }
  }
  return drive.id;
}

/**
 * The org pool and one drive wallet under it, the drive's default source, with the fallback rule
 * `refuse`: a paused or empty drive wallet then refuses the call by name instead of quietly moving
 * to another source, which is the state the refusal surfaces exist for (SPEND-4).
 */
export async function seedOrgDriveWallet(opts: {
  orgId: string;
  driveId: string;
  poolCents?: number;
  allocationCents?: number;
}): Promise<{ poolId: string; walletId: string }> {
  const [pool] = await db
    .insert(wallets)
    .values({ ownerType: 'org', orgId: opts.orgId, monthlyRemainingCents: opts.poolCents ?? 900_000 })
    .returning({ id: wallets.id });
  const [wallet] = await db
    .insert(wallets)
    .values({
      ownerType: 'org',
      orgId: opts.orgId,
      subjectType: 'drive',
      subjectId: opts.driveId,
      parentWalletId: pool.id,
      monthlyAllowanceCents: opts.allocationCents ?? 120_000,
      monthlyPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
      defaultSpendSource: 'drive_wallet',
      fallbackRule: 'refuse',
    })
    .returning({ id: wallets.id });
  return { poolId: pool.id, walletId: wallet.id };
}

/** An open invitation, as the invite route stores it (only the token's hash is kept). */
export async function seedOrgInvitation(orgId: string, invitedBy: string, email: string): Promise<string> {
  const [row] = await db
    .insert(orgInvitations)
    .values({
      orgId,
      email,
      role: 'MEMBER',
      invitedBy,
      tokenHash: createId(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: orgInvitations.id });
  return row.id;
}

/** A unique address on a reserved test domain. */
export function inviteeEmail(local = 'lena'): string {
  return `${local}-${createId().slice(0, 8)}@northwind.test`;
}

/**
 * Wide enough that the left sidebar is a persistent panel and the header shows every chip at
 * full size (Layout overlays the sidebar under 1280px; the Desktop Chrome preset sits on it).
 */
export const DESKTOP_VIEWPORT = { width: 1600, height: 1000 };

/**
 * Open the drive picker from the left sidebar's drive switcher (the one list of drives; the
 * header crumb opens the same dialog). Returns the dialog.
 */
export async function openDrivePicker(page: Page, currentDriveName: string): Promise<Locator> {
  const trigger = page.locator('aside').getByRole('button', { name: currentDriveName });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByPlaceholder('Search drives…')).toBeVisible();
  return dialog;
}

/**
 * Mark the current document, so a later `expectSameDocument` proves an update arrived WITHOUT a
 * reload or navigation: a new document has no marker.
 */
export async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __e2eSameDocument?: boolean }).__e2eSameDocument = true;
  });
}

export async function expectSameDocument(page: Page): Promise<void> {
  const marked = await page.evaluate(() => (window as Window & { __e2eSameDocument?: boolean }).__e2eSameDocument === true);
  expect(marked, 'the page reloaded or navigated: the update did not arrive live').toBe(true);
}

/** Optional rendered evidence for an independent review; never a screenshot baseline assertion. */
export async function captureOrgEvidence(page: Page, name: string): Promise<void> {
  const directory = process.env.E2E_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
}

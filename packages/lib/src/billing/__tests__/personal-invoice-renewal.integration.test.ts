import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditLedger } from '@pagespace/db/schema/credits';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { applyStripeFunding, type FundingEvent } from '../credit-funding';
import { allowanceCentsForPaidCents } from '../money-model';
import { resetDueAllocations } from '../wallet-funding-shell';

const START = new Date('2026-10-01T00:00:00Z');
const END = new Date('2026-11-01T00:00:00Z');
const created = { users: [] as string[], drives: [] as string[], children: [] as string[] };
const originalMode = process.env.DEPLOYMENT_MODE;

beforeAll(async () => {
  try {
    await db.select({ id: wallets.id }).from(wallets).limit(1);
  } catch (error) {
    requireDb('personal-invoice-renewal.integration.test.ts', error);
  }
  process.env.DEPLOYMENT_MODE = 'cloud';
});

afterAll(async () => {
  if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
  else process.env.DEPLOYMENT_MODE = originalMode;
  await db.delete(creditLedger).where(inArray(creditLedger.userId, created.users));
  await db.delete(wallets).where(inArray(wallets.id, created.children));
  await db.delete(wallets).where(inArray(wallets.userId, created.users));
  await db.delete(drives).where(inArray(drives.id, created.drives));
  await db.delete(users).where(inArray(users.id, created.users));
});

async function fixture() {
  const customer = `cus_${createId()}`;
  const subscription = `sub_${createId()}`;
  const owner = await factories.createUser({ subscriptionTier: 'pro', stripeCustomerId: customer });
  created.users.push(owner.id);
  await db.insert(subscriptions).values({ userId: owner.id, stripeSubscriptionId: subscription, stripePriceId: 'price_verified_personal_pro', status: 'active', currentPeriodStart: START, currentPeriodEnd: END });
  const [root] = await db.insert(wallets).values({ userId: owner.id }).returning();
  const drive = await factories.createDrive(owner.id);
  created.drives.push(drive.id);
  const [child] = await db.insert(wallets).values({ userId: owner.id, parentWalletId: root.id, subjectType: 'drive', subjectId: drive.id, monthlyAllowanceCents: 150, spentCents: 150, monthlyPeriodStart: START, monthlyPeriodEnd: END }).returning();
  created.children.push(child.id);
  const invoice = (start: Date, end: Date, paid: number): FundingEvent => ({
    id: `evt_${createId()}`, type: 'invoice.paid', data: { object: {
      id: `in_${createId()}`, customer, amount_paid: paid, billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription } },
      lines: { data: [{ period: { start: start.getTime() / 1000, end: end.getTime() / 1000 } }] },
    } },
  });
  return { owner, root, child, invoice };
}

const wallet = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];

describe('personal invoice ordering preserves the drive renewal clock', () => {
  it('credits distinct reverse-delivered paid invoices once without rewinding the current allowance or delaying child renewal', async () => {
    const w = await fixture();
    const current = w.invoice(START, END, 1500);
    const late = w.invoice(new Date('2026-09-01T00:00:00Z'), START, 1000);
    // The funding shell receives the verified personal tier from its webhook caller.
    // This test exercises persistence and renewal, not price-identity authorization.
    await applyStripeFunding(current, { tier: 'pro' });
    await applyStripeFunding(late, { tier: 'pro' });
    const total = allowanceCentsForPaidCents(1500, 'pro') + allowanceCentsForPaidCents(1000, 'pro');
    const root = await wallet(w.root.id);
    expect(root).toMatchObject({ monthlyRemainingCents: total, monthlyAllowanceCents: allowanceCentsForPaidCents(1500, 'pro'), monthlyPeriodStart: START, monthlyPeriodEnd: END });
    await applyStripeFunding(late, { tier: 'pro' });
    await applyStripeFunding(current, { tier: 'pro' });
    expect(await wallet(w.root.id)).toEqual(root);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.userId, w.owner.id))).toHaveLength(2);
    await resetDueAllocations({ now: END });
    expect(await wallet(w.child.id)).toMatchObject({ spentCents: 0, monthlyPeriodStart: END });
    expect((await wallet(w.root.id)).monthlyRemainingCents).toBe(total);
  });
});

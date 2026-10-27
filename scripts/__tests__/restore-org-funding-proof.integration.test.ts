import { afterEach, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgSubscriptions, orgSubscriptionFunding } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { creditLedger } from '@pagespace/db/schema/credits';
import { eq, inArray } from '@pagespace/db/operators';
import { createFundingProofStore, type FundingProof } from '../restore-org-funding-proof';

const owned: Array<{ orgId: string; userId: string }> = [];
afterEach(async () => {
  for (const row of owned.splice(0)) {
    const pools = await db.select({ id: wallets.id }).from(wallets).where(eq(wallets.orgId, row.orgId));
    if (pools.length) await db.delete(creditLedger).where(inArray(creditLedger.walletId, pools.map(pool => pool.id)));
    await db.delete(wallets).where(eq(wallets.orgId, row.orgId));
    await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, row.orgId));
    await db.delete(organizations).where(eq(organizations.id, row.orgId));
    await db.delete(users).where(eq(users.id, row.userId));
  }
});
async function seed(): Promise<FundingProof> {
  const id = createId();
  const [user] = await db.insert(users).values({ email: `${id}@example.test`, name: 'Funding proof test' }).returning();
  const [org] = await db.insert(organizations).values({ name: 'Proof', slug: id, ownerId: user.id, stripeCustomerId: `cus_${id}` }).returning();
  owned.push({ orgId: org.id, userId: user.id });
  await db.insert(orgSubscriptions).values({ orgId: org.id, stripeSubscriptionId: `sub_${id}`, status: 'active', stripeBasePriceId: 'price_base', stripeSeatPriceId: 'price_seat', stripeBaseItemId: 'si_base', stripeSeatItemId: 'si_seat' });
  const [pool] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 123, topupRemainingCents: 456, debtCents: 20 }).returning();
  await db.insert(creditLedger).values({ userId: user.id, walletId: pool.id, entryType: 'monthly_grant', bucket: 'monthly', amountCents: 5000, stripeRef: `in_${id}`, consumeStatus: 'applied' });
  return { orgId: org.id, customerId: `cus_${id}`, subscriptionId: `sub_${id}`, invoiceId: `in_${id}`, basis: 'paid', paidCents: 5000 };
}
describe('historical funding evidence PostgreSQL store', () => {
  it('SEAT-9 (partial) concurrent recovery inserts once and preserves every wallet and ledger field', async () => {
    const proof = await seed();
    const store = createFundingProofStore(db);
    const beforeWallets = await db.select().from(wallets).where(eq(wallets.orgId, proof.orgId));
    const beforeLedger = await db.select().from(creditLedger).where(eq(creditLedger.stripeRef, proof.invoiceId));
    expect(await store.loadOrg(proof.orgId)).toMatchObject({ customerId: proof.customerId, subscriptionId: proof.subscriptionId });
    const applied = await Promise.all([store.apply(proof), store.apply(proof), store.apply(proof)]);
    expect(applied.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(orgSubscriptionFunding).where(eq(orgSubscriptionFunding.orgId, proof.orgId))).toHaveLength(1);
    expect(await db.select().from(wallets).where(eq(wallets.orgId, proof.orgId))).toEqual(beforeWallets);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.stripeRef, proof.invoiceId))).toEqual(beforeLedger);
  });
  it.each(['customer', 'subscription'] as const)('SEAT-9 (partial) refuses a changed %s binding without proof', async (changed) => {
    const proof = await seed();
    if (changed === 'customer') await db.update(organizations).set({ stripeCustomerId: `cus_changed_${createId()}` }).where(eq(organizations.id, proof.orgId));
    else await db.update(orgSubscriptions).set({ stripeSubscriptionId: `sub_changed_${createId()}` }).where(eq(orgSubscriptions.orgId, proof.orgId));
    await expect(createFundingProofStore(db).apply(proof)).rejects.toThrow('evidence changed');
    expect(await db.select().from(orgSubscriptionFunding).where(eq(orgSubscriptionFunding.orgId, proof.orgId))).toEqual([]);
  });
});

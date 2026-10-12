#!/usr/bin/env bun
/** Restore verified first-payment evidence only. Never mutate Stripe, wallets or ledger. */
import { pathToFileURL } from 'node:url';
import type Stripe from 'stripe';
import type { db as appDb } from '@pagespace/db/db';
import { organizations, orgSubscriptions, orgSubscriptionFunding } from '@pagespace/db/schema/organizations';
import { eq } from '@pagespace/db/operators';
import { orgInvoiceFundingInput, orgInvoicePaidCents, orgSubscriptionFundingBasis, type OrgInvoice } from '@pagespace/lib/billing/wallet-funding';

export interface OrgBinding { orgId: string; customerId: string; subscriptionId: string }
export interface FundingProof extends OrgBinding { invoiceId: string; basis: 'paid' | 'gift'; paidCents: number }
export type PaidInvoice = OrgInvoice & { status?: string | null; lines?: NonNullable<OrgInvoice['lines']> & { has_more?: boolean } };
interface Prices { basePriceId: string; seatPriceId: string }
interface ProofDeps {
  loadOrg(orgId: string): Promise<OrgBinding>;
  readInvoice(invoiceId: string): Promise<PaidInvoice>;
  apply(proof: FundingProof): Promise<boolean>;
  prices: Prices;
}
function idOf(value: string | { id?: string | null } | null | undefined): string | null {
  return typeof value === 'string' ? value : value?.id ?? null;
}

/** Uses the funding path's price and gift rules, without applying any credit ratio. */
export function planFundingProof(org: OrgBinding, invoice: PaidInvoice, prices: Prices): FundingProof {
  if (!invoice.id || invoice.status !== 'paid' || invoice.lines?.has_more !== false) throw new Error('A complete paid Stripe invoice is required');
  if (idOf(invoice.customer) !== org.customerId || idOf(invoice.parent?.subscription_details?.subscription) !== org.subscriptionId) {
    throw new Error('Invoice does not belong to the current organization subscription');
  }
  if (!prices.basePriceId || !prices.seatPriceId || prices.basePriceId === prices.seatPriceId) throw new Error('Organization price configuration is incomplete or ambiguous');
  const { input } = orgInvoiceFundingInput(invoice, { prices, storedSubscriptionId: org.subscriptionId });
  const basis = orgSubscriptionFundingBasis(input);
  if (!basis) throw new Error('Invoice has no verified organization funding');
  return { ...org, invoiceId: invoice.id, basis, paidCents: orgInvoicePaidCents(input) };
}

export async function restoreFundingProof(deps: ProofDeps, options: { orgId: string; invoiceId: string; apply: boolean }) {
  const org = await deps.loadOrg(options.orgId);
  const invoice = await deps.readInvoice(options.invoiceId);
  if (org.orgId !== options.orgId || invoice.id !== options.invoiceId) throw new Error('Requested evidence identity mismatch');
  const proof = planFundingProof(org, invoice, deps.prices);
  const applied = options.apply ? await deps.apply(proof) : false;
  return { proof, applied, dryRun: !options.apply };
}

export function createFundingProofStore(db: typeof appDb): Pick<ProofDeps, 'loadOrg' | 'apply'> {
  return {
    async loadOrg(orgId) {
      const [row] = await db.select({ orgId: organizations.id, customerId: organizations.stripeCustomerId,
        subscriptionId: orgSubscriptions.stripeSubscriptionId }).from(organizations)
        .innerJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organizations.id)).where(eq(organizations.id, orgId));
      if (!row?.customerId || !row.subscriptionId) throw new Error('Organization has no current customer/subscription binding');
      return { ...row, customerId: row.customerId, subscriptionId: row.subscriptionId };
    },
    async apply(proof) {
      return db.transaction(async (tx) => {
        const [org] = await tx.select({ customerId: organizations.stripeCustomerId }).from(organizations)
          .where(eq(organizations.id, proof.orgId)).for('update');
        const [sub] = await tx.select({ subscriptionId: orgSubscriptions.stripeSubscriptionId }).from(orgSubscriptions)
          .where(eq(orgSubscriptions.orgId, proof.orgId)).for('update');
        if (org?.customerId !== proof.customerId || sub?.subscriptionId !== proof.subscriptionId) throw new Error('Organization billing evidence changed; verify again');
        const [inserted] = await tx.insert(orgSubscriptionFunding).values({ orgId: proof.orgId,
          stripeSubscriptionId: proof.subscriptionId, stripeInvoiceId: proof.invoiceId, basis: proof.basis, paidCents: proof.paidCents,
        }).onConflictDoNothing().returning({ id: orgSubscriptionFunding.id });
        if (inserted) return true;
        const [existing] = await tx.select({ orgId: orgSubscriptionFunding.orgId, subscriptionId: orgSubscriptionFunding.stripeSubscriptionId })
          .from(orgSubscriptionFunding).where(eq(orgSubscriptionFunding.stripeInvoiceId, proof.invoiceId));
        if (existing && (existing.orgId !== proof.orgId || existing.subscriptionId !== proof.subscriptionId)) throw new Error('Invoice proof belongs to another subscription');
        return false;
      });
    },
  };
}

/** Stripe auto-pagination must complete before returning any evidence. */
export function createPaidInvoiceReader(stripe: Stripe): ProofDeps['readInvoice'] {
  return async (invoiceId) => {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    const lines: Stripe.InvoiceLineItem[] = [];
    for await (const line of stripe.invoices.listLineItems(invoiceId, { limit: 100 })) lines.push(line);
    return { ...invoice, lines: { ...invoice.lines, data: lines, has_more: false } };
  };
}

export function parseProofOptions(argv: readonly string[]): { orgId: string; invoiceId: string; apply: boolean } {
  let orgId = ''; let invoiceId = ''; let mode: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply' || arg === '--dry-run') {
      if (mode) throw new Error('Choose one mode');
      mode = arg;
    } else if (arg === '--org' || arg === '--invoice') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing identifier');
      if (arg === '--org' && !orgId) orgId = value;
      else if (arg === '--invoice' && !invoiceId) invoiceId = value;
      else throw new Error('Duplicate identifier');
    } else throw new Error('Unknown argument');
  }
  if (!orgId || !invoiceId) throw new Error('Provide --org and --invoice');
  return { orgId, invoiceId, apply: mode === '--apply' };
}

async function main() {
  const options = parseProofOptions(process.argv.slice(2));
  const { isBillingEnabled } = await import('@pagespace/lib/deployment-mode');
  if (!isBillingEnabled()) throw new Error('Funding proof is not used in billing-disabled deployments');
  const { getMigrationDb } = await import('@pagespace/db/db');
  const { stripe } = await import('../apps/web/src/lib/stripe/client');
  const { stripeConfig } = await import('../apps/web/src/lib/stripe-config');
  const result = await restoreFundingProof({ ...createFundingProofStore(getMigrationDb()), readInvoice: createPaidInvoiceReader(stripe),
    prices: { basePriceId: stripeConfig.orgPriceIds.businessBase, seatPriceId: stripeConfig.orgPriceIds.extraSeat },
  }, options);
  if (result.applied) {
    const { recordOrgAuditEventAfterCommit } = await import('@pagespace/lib/audit/org-audit');
    const { announceOrgChange } = await import('@pagespace/lib/organizations/org-change-events');
    await recordOrgAuditEventAfterCommit({ orgId: result.proof.orgId, eventType: 'org.billing.subscription_changed',
      resourceType: 'org_subscription', resourceId: result.proof.orgId,
      details: { source: 'verified_funding_recovery', stripeSubscriptionId: result.proof.subscriptionId,
        invoiceId: result.proof.invoiceId, basis: result.proof.basis, paidCents: result.proof.paidCents },
    });
    await announceOrgChange(result.proof.orgId, 'status');
  }
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}

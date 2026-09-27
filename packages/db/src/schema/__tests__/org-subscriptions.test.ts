/**
 * Organizations & Wallets epic, Phase 3 (D1) — schema-level proof of `org_subscriptions`,
 * the org's Business subscription linkage (Spec SEAT-1, A-8). Runs without a database;
 * the constraints are exercised against a real Postgres by the web shell's integration
 * suite (apps/web/src/lib/org-billing).
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import * as schemaModule from '../../schema';
import { organizations, orgSubscriptions } from '../organizations';

function foreignKeyOn(table: PgTable, column: string) {
  const fk = getTableConfig(table).foreignKeys.find((f) => f.reference().columns.some((c) => c.name === column));
  if (!fk) throw new Error(`no FK on ${column}`);
  return { onDelete: fk.onDelete, target: getTableConfig(fk.reference().foreignTable).name };
}

describe('org_subscriptions', () => {
  const columns = getTableColumns(orgSubscriptions);

  it('SEAT-1 (partial) is registered in the combined schema under its own table name', () => {
    expect(schemaModule.schema.orgSubscriptions).toBe(orgSubscriptions);
    expect(getTableConfig(orgSubscriptions).name).toBe('org_subscriptions');
  });

  it('SEAT-1 (partial) is keyed on orgId: one subscription row per org, and an org with a subscription cannot be deleted out from under it', () => {
    expect(columns.orgId.notNull).toBe(true);
    expect(columns.orgId.isUnique).toBe(true);
    expect(foreignKeyOn(orgSubscriptions, 'orgId')).toEqual({ onDelete: 'restrict', target: 'organizations' });
  });

  it('SEAT-1 (partial) A-8 stores the linkage: subscription id (unique), base item and extra-seat item ids, and the seat quantity Stripe was set to', () => {
    expect(columns.stripeSubscriptionId.notNull).toBe(true);
    expect(columns.stripeSubscriptionId.isUnique).toBe(true);
    for (const c of ['stripeBaseItemId', 'stripeSeatItemId', 'stripeBasePriceId', 'stripeSeatPriceId', 'status'] as const) {
      expect(columns[c].notNull, c).toBe(true);
    }
    expect(columns.extraSeatQuantity.notNull).toBe(true);
    expect(columns.extraSeatQuantity.default).toBe(0);
    expect(columns.seatRevision.notNull).toBe(true);
    expect(columns.seatRevision.default).toBe(0);
  });

  it('SEAT-8 (partial) records the trial end and the current period, both nullable until Stripe reports them', () => {
    for (const c of ['trialEnd', 'currentPeriodStart', 'currentPeriodEnd'] as const) {
      expect(columns[c].notNull, c).toBe(false);
    }
    expect(columns.cancelAtPeriodEnd.notNull).toBe(true);
  });

  it('SEAT-1 (partial) the org customer stays on organizations.stripeCustomerId, unique across orgs', () => {
    const orgColumns = getTableColumns(organizations);
    expect(orgColumns.stripeCustomerId.isUnique).toBe(true);
  });
});

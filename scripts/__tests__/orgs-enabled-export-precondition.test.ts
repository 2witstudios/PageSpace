/**
 * Turning orgs on was mechanically blocked on the export work: shipping
 * ORGS_ENABLED = true while either export dropped org data would export org
 * users' data without their org membership (GDPR, Spec X-2) and migrate an org
 * drive as a personal drive with its balances gone (tenant export, Spec X-3).
 *
 * Both are now met, so these assertions hold UNCONDITIONALLY rather than only
 * once the flag flips: a later change that drops an org or wallet table from
 * either export fails here whatever the flag says.
 *
 *  - GDPR: no org table may sit in EXCLUDED_TABLES under a "temporary X-2" reason.
 *  - Tenant: `drives.orgId` is carried, every org and wallet table is carried,
 *    and every table hanging directly off an org or a wallet is either carried
 *    or excluded with a written reason (derived from the Drizzle schema, so a
 *    new one cannot slip past).
 */
import { describe, it, expect } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as dbSchema from '@pagespace/db/schema';
import { EXCLUDED_TABLES } from '../../packages/lib/src/compliance/export/gdpr-export-coverage';
import { TABLE_IMPORT_ORDER } from '../lib/migration-types';
import { TENANT_EXPORT_EXCLUDED_TABLES, carriedColumns } from '../lib/tenant-export-columns';

/** The GDPR export's temporary org exclusions still present; empty once X-2 landed. */
function temporaryGdprOrgExclusions(gdprExcludedTables: Readonly<Record<string, string>>): string[] {
  return ['organizations', 'org_members', 'drive_join_requests', 'org_member_departures']
    .filter((table) => {
      const reason = gdprExcludedTables[table];
      return reason !== undefined && /\bX-2\b/.test(reason) && /temporary/i.test(reason);
    })
    .map((table) => `gdpr EXCLUDED_TABLES.${table}`);
}

/** Every org and wallet table a tenant migration must carry for an org drive to arrive whole. */
const ORG_WALLET_TABLES = [
  'organizations',
  'org_members',
  'org_invitations',
  'org_subscriptions',
  'org_subscription_funding',
  'org_domains',
  'org_member_departures',
  'org_departure_suppressions',
  'org_guest_holds',
  'drive_join_requests',
  'wallets',
  'wallet_funding_legs',
  'wallet_consumer_caps',
  'wallet_debt_notices',
  'wallet_cap_alerts',
  'drive_spend_overrides',
  'automation_skip_notices',
] as const;

/** `organizations`, `wallets`, and every table with a foreign key onto either. */
function tablesOnAnOrgOrWallet(): string[] {
  const found = new Set(['organizations', 'wallets']);
  for (const value of Object.values(dbSchema as Record<string, unknown>)) {
    if (!value || !is(value, PgTable)) continue;
    const refs = getTableConfig(value).foreignKeys.map((fk) => getTableName(fk.reference().foreignTable));
    if (refs.some((ref) => ref === 'organizations' || ref === 'wallets')) found.add(getTableName(value));
  }
  return [...found].sort();
}

/** What a tenant migration of an org drive would still lose. */
function tenantOrgWalletGaps(input: {
  carried: readonly string[];
  excluded: Readonly<Record<string, string>>;
  drivesCarried: readonly string[];
  onAnOrgOrWallet: readonly string[];
}): string[] {
  const carried = new Set(input.carried);
  return [
    ...(input.drivesCarried.includes('orgId') ? [] : ['tenant export drives.orgId']),
    ...ORG_WALLET_TABLES.filter((t) => !carried.has(t)).map((t) => `tenant export ${t}`),
    ...input.onAnOrgOrWallet
      .filter((t) => !carried.has(t) && !(t in input.excluded))
      .map((t) => `tenant export undecided ${t}`),
  ];
}

describe('ORGS_ENABLED export precondition', () => {
  it('X-2 (partial) no org table is excluded from the GDPR export as a temporary measure', () => {
    expect(temporaryGdprOrgExclusions(EXCLUDED_TABLES)).toEqual([]);
  });

  it('X-3 (partial) the tenant export carries drives.orgId and every org and wallet table, and decides every table that hangs off one', () => {
    expect(tenantOrgWalletGaps({
      carried: TABLE_IMPORT_ORDER,
      excluded: TENANT_EXPORT_EXCLUDED_TABLES,
      drivesCarried: carriedColumns('drives'),
      onAnOrgOrWallet: tablesOnAnOrgOrWallet(),
    })).toEqual([]);
  });

  it('the detectors flag each gap shape and pass a complete export, so the guards are not vacuous', () => {
    expect(temporaryGdprOrgExclusions({
      organizations: 'Temporary under Spec X-2: removed by Phase 6.',
      org_members: 'Temporary under Spec X-2: removed by Phase 6.',
      org_invitations: 'Permanent Art 15(4) boundary.',
    })).toEqual(['gdpr EXCLUDED_TABLES.organizations', 'gdpr EXCLUDED_TABLES.org_members']);

    expect(tenantOrgWalletGaps({
      carried: ORG_WALLET_TABLES.filter((t) => t !== 'wallets'),
      excluded: { credit_holds: 'In-flight reservations of the source instance.' },
      drivesCarried: ['id', 'ownerId'],
      onAnOrgOrWallet: ['wallets', 'credit_holds', 'credit_ledger'],
    })).toEqual([
      'tenant export drives.orgId',
      'tenant export wallets',
      'tenant export undecided wallets',
      'tenant export undecided credit_ledger',
    ]);
    expect(tenantOrgWalletGaps({
      carried: ORG_WALLET_TABLES,
      excluded: {},
      drivesCarried: ['orgId'],
      onAnOrgOrWallet: [...ORG_WALLET_TABLES],
    })).toEqual([]);
  });

  it('derives the org/wallet table set from the schema (it includes the ledger and holds, which must be decided)', () => {
    expect(tablesOnAnOrgOrWallet()).toEqual(expect.arrayContaining(['org_members', 'wallet_funding_legs', 'credit_ledger', 'credit_holds', 'drives']));
  });
});

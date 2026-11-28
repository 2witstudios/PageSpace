/**
 * The pure half of the tenant bundle's org/wallet selection (Spec X-3):
 * which orgs move with their money, and which wallets travel.
 */
import { describe, it, expect } from 'vitest';
import {
  migratingOrgIds,
  keptWalletIds,
  orgWalletSelectionWhere,
  type OrgWalletScope,
  type WalletRef,
} from '../lib/org-wallet-selection';

const wallet = (id: string, over: Partial<WalletRef> = {}): WalletRef => ({
  id, subjectType: null, subjectId: null, parentWalletId: null, ...over,
});

describe('migratingOrgIds', () => {
  it('an org migrates only when its Owner is a requested user', () => {
    expect(migratingOrgIds(
      [{ id: 'o2', ownerId: 'alice' }, { id: 'o1', ownerId: 'eve' }, { id: 'o0', ownerId: 'bob' }],
      new Set(['alice', 'bob']),
    )).toEqual(['o0', 'o2']);
  });
});

describe('keptWalletIds', () => {
  const bundle = { driveIds: new Set(['d1']), pageIds: new Set(['p1']) };

  it('keeps root wallets and subject wallets whose drive or agent page travels', () => {
    expect(keptWalletIds([
      wallet('root'),
      wallet('dw', { subjectType: 'drive', subjectId: 'd1', parentWalletId: 'root' }),
      wallet('aw', { subjectType: 'agent_page', subjectId: 'p1', parentWalletId: 'root' }),
    ], bundle)).toEqual(['aw', 'dw', 'root']);
  });

  it('drops a subject wallet whose subject stays behind, and every wallet allocated from it', () => {
    expect(keptWalletIds([
      wallet('root'),
      wallet('gone', { subjectType: 'drive', subjectId: 'd9', parentWalletId: 'root' }),
      wallet('child', { subjectType: 'agent_page', subjectId: 'p1', parentWalletId: 'gone' }),
      wallet('grandchild', { subjectType: 'agent_page', subjectId: 'p1', parentWalletId: 'child' }),
    ], bundle)).toEqual(['root']);
  });

  it('drops a wallet whose parent is not a candidate, rather than re-rooting it', () => {
    expect(keptWalletIds([
      wallet('dw', { subjectType: 'drive', subjectId: 'd1', parentWalletId: 'someone-elses-pool' }),
    ], bundle)).toEqual([]);
  });
});

describe('orgWalletSelectionWhere', () => {
  const scope: OrgWalletScope = {
    driveIn: "'d1'", allUserIn: "'u1'", orgIn: "'o1', 'o2'", migratingOrgIn: "'o1'", walletIn: "'w1'",
  };

  it('scopes what adds access or holds money to migrating orgs only', () => {
    for (const table of ['org_invitations', 'org_subscriptions', 'org_subscription_funding', 'org_domains'] as const) {
      expect(orgWalletSelectionWhere(table, scope)).toBe(`"orgId" IN ('o1')`);
    }
  });

  it('carries departure suppressions for every carried org: they only ever refuse a join (D-OW-27)', () => {
    expect(orgWalletSelectionWhere('org_departure_suppressions', scope)).toBe(`"orgId" IN ('o1', 'o2')`);
  });

  it('scopes memberships to every carried org and every carried user', () => {
    expect(orgWalletSelectionWhere('org_members', scope)).toBe(`"orgId" IN ('o1', 'o2') AND "userId" IN ('u1')`);
  });

  it('scopes a wallet\'s children by the kept wallet ids', () => {
    expect(orgWalletSelectionWhere('wallet_funding_legs', scope)).toBe(`"walletId" IN ('w1')`);
    expect(orgWalletSelectionWhere('wallets', scope)).toBe(`id IN ('w1')`);
  });
});

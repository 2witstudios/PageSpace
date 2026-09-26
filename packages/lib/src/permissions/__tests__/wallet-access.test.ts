import { describe, it, expect } from 'vitest';
import { walletViewerRole, walletActionsFor, mayTakeWalletAction, credentialRefusalFor, viewerForCredential, WALLET_ACTIONS, type WalletStanding, type WalletWrite } from '../wallet-access';

// Northwind Labs fixture: Jono owns the org, Priya is an Admin, Marcus a member, Chris Rowe a
// guest on Product; Dana (a member) leads Engineering. Personal drives have no org.
const standing = (over: Partial<WalletStanding> = {}): WalletStanding => ({
  orgId: 'o-northwind',
  isLead: false,
  isDriveMember: true,
  orgRole: 'MEMBER',
  ...over,
});

describe('wallet-access: who is looking at a drive wallet', () => {
  it('SPEND-10 (partial) an org Owner or Admin is an org admin on every drive of the org, member or not', () => {
    expect(walletViewerRole(standing({ orgRole: 'ADMIN', isDriveMember: false }))).toBe('org_admin');
    expect(walletViewerRole(standing({ orgRole: 'OWNER' }))).toBe('org_admin');
  });

  it('SPEND-10 (partial) the drive lead is the lead', () => {
    expect(walletViewerRole(standing({ isLead: true }))).toBe('lead');
    expect(walletViewerRole(standing({ orgId: null, orgRole: null, isLead: true }))).toBe('lead');
  });

  it('SPEND-9 (partial) an effective member in the org is a consumer; a drive member outside the org is a guest', () => {
    expect(walletViewerRole(standing())).toBe('member');
    expect(walletViewerRole(standing({ orgRole: null }))).toBe('guest');
    expect(walletViewerRole(standing({ orgId: null, orgRole: null }))).toBe('member');
  });

  it('SPEND-9 (partial) an org member with no membership of the drive (a Restricted drive not joined) sees nothing', () => {
    expect(walletViewerRole(standing({ isDriveMember: false }))).toBe('none');
    expect(walletViewerRole(standing({ orgId: null, orgRole: null, isDriveMember: false }))).toBe('none');
  });

  it('an org role on a PERSONAL drive grants nothing (the drive has no org)', () => {
    expect(walletViewerRole(standing({ orgId: null, orgRole: 'ADMIN', isDriveMember: false }))).toBe('none');
  });
});

describe('wallet-access: what each may do', () => {
  it('UI-9 (partial) on an org drive only org admins move pool money (create, allocate, top up, delete); the lead runs the wallet (pause, rules) and reads spend by member', () => {
    expect(walletActionsFor('org_admin', { orgDrive: true })).toEqual([...WALLET_ACTIONS]);
    expect(walletActionsFor('lead', { orgDrive: true })).toEqual(['view', 'view_spend_by_member', 'pause', 'set_rules', 'donate']);
  });

  it('UI-9 (partial) on a personal drive the lead funds and runs the wallet: every action', () => {
    expect(walletActionsFor('lead', { orgDrive: false })).toEqual([...WALLET_ACTIONS]);
  });

  it('SPEND-9 (partial) WAL-4 (partial) a member or a guest may view the consumer projection and donate, nothing else', () => {
    for (const role of ['member', 'guest'] as const) {
      for (const orgDrive of [true, false]) {
        expect(walletActionsFor(role, { orgDrive })).toEqual(['view', 'donate']);
      }
    }
  });

  it('a non-member may do nothing', () => {
    expect(walletActionsFor('none', { orgDrive: true })).toEqual([]);
    expect(mayTakeWalletAction('none', 'view', { orgDrive: false })).toBe(false);
  });

  it('SPEND-10 (partial) only the lead and org admins read spend by member', () => {
    expect(mayTakeWalletAction('member', 'view_spend_by_member', { orgDrive: true })).toBe(false);
    expect(mayTakeWalletAction('lead', 'view_spend_by_member', { orgDrive: true })).toBe(true);
    expect(mayTakeWalletAction('org_admin', 'view_spend_by_member', { orgDrive: true })).toBe(true);
  });
});

describe('wallet-access: the credential ([D-OW-26])', () => {
  const MONEY_WRITES: WalletWrite[] = ['create', 'allocate', 'top_up', 'pause', 'set_rules', 'delete', 'donate'];

  it('X-1 (partial) an MCP/CLI token is refused every money write by name; a session is not', () => {
    for (const write of MONEY_WRITES) {
      expect(credentialRefusalFor('mcp', write), write).toMatchObject({ code: 'mcp_token_cannot_move_money' });
      expect(credentialRefusalFor('session', write), write).toBeNull();
    }
  });

  it('SPEND-3 (partial) an MCP/CLI token may not change a conversation\'s source or the personal default', () => {
    for (const write of ['set_conversation_source', 'set_default_source'] as const) {
      expect(credentialRefusalFor('mcp', write)).toMatchObject({ code: 'mcp_token_cannot_change_spend_source' });
      expect(credentialRefusalFor('session', write)).toBeNull();
    }
  });

  it('SPEND-9 (partial) a token reads the consumer projection whatever the role; a session reads as its role', () => {
    expect(viewerForCredential('org_admin', 'mcp')).toBe('member');
    expect(viewerForCredential('lead', 'mcp')).toBe('member');
    expect(viewerForCredential('guest', 'mcp')).toBe('guest');
    expect(viewerForCredential('org_admin', 'session')).toBe('org_admin');
  });
});

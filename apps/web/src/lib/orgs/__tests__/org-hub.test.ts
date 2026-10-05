import { describe, it, expect } from 'vitest';
import { orgHubSections, type OrgHubCounts } from '../org-hub';

const counts: OrgHubCounts = {
  members: 12,
  pendingInvites: 2,
  guests: 3,
  drives: 6,
  guestApprovals: 2,
  ownerLeftAutomations: 1,
};

const titles = (sections: ReturnType<typeof orgHubSections>) => sections.map((s) => s.title);
const rows = (sections: ReturnType<typeof orgHubSections>) => sections.flatMap((s) => s.rows.map((r) => r.title));

describe('orgHubSections', () => {
  it('UI-11 (partial): a plain Member sees only Leave, no org settings', () => {
    const sections = orgHubSections({ orgId: 'o1', orgName: 'Northwind Labs', role: 'MEMBER', counts, billingEnabled: true });
    expect(titles(sections)).toEqual(['Membership']);
    expect(rows(sections)).toEqual(['Leave Northwind Labs']);
    expect(sections[0].rows[0]).toMatchObject({ action: 'leave' });
  });

  it('UI-1 (partial): an Admin sees the canvas groups in order, each row linking under /orgs/[orgId]/settings', () => {
    const sections = orgHubSections({ orgId: 'o1', orgName: 'Northwind Labs', role: 'ADMIN', counts, billingEnabled: true });
    expect(titles(sections)).toEqual(['Needs your attention', 'Organization', 'Controls', 'Billing', 'Data', 'Membership']);
    expect(rows(sections)).toEqual([
      'Guest approvals', 'Automations whose owner left',
      'General', 'Members & seats', 'Drives',
      'Policies', 'Security', 'Audit log',
      'Plan & seats', 'Usage',
      'Backups',
      'Leave Northwind Labs',
    ]);
    for (const row of sections.flatMap((s) => s.rows)) {
      if (row.href) expect(row.href.startsWith('/orgs/o1/settings')).toBe(true);
    }
  });

  it('the Owner also gets the Danger Zone, and cannot leave (ownership must be transferred first)', () => {
    const sections = orgHubSections({ orgId: 'o1', orgName: 'N', role: 'OWNER', counts, billingEnabled: true });
    expect(titles(sections)).toContain('Administration');
    expect(rows(sections)).toContain('Danger Zone');
    expect(rows(sections)).not.toContain('Leave N');
  });

  it('an Admin gets no Danger Zone', () => {
    expect(rows(orgHubSections({ orgId: 'o1', orgName: 'N', role: 'ADMIN', counts, billingEnabled: true }))).not.toContain('Danger Zone');
  });

  it('describes members, invites, guests and drives with live counts', () => {
    const all = orgHubSections({ orgId: 'o1', orgName: 'Northwind Labs', role: 'ADMIN', counts, billingEnabled: true }).flatMap((s) => s.rows);
    expect(all.find((r) => r.title === 'Members & seats')).toMatchObject({ description: '12 members, 2 pending invites, 3 guests', badge: '2 pending' });
    expect(all.find((r) => r.title === 'Drives')?.description).toBe('6 drives owned by Northwind Labs and who can see them');
    expect(all.find((r) => r.title === 'Guest approvals')?.badge).toBe('2 waiting');
    expect(all.find((r) => r.title === 'Automations whose owner left')?.badge).toBe('1 disabled');
  });

  it('uses singular nouns for one', () => {
    const all = orgHubSections({ orgId: 'o1', orgName: 'N', role: 'ADMIN', counts: { ...counts, members: 1, pendingInvites: 1, guests: 1, drives: 1 }, billingEnabled: true }).flatMap((s) => s.rows);
    expect(all.find((r) => r.title === 'Members & seats')?.description).toBe('1 member, 1 pending invite, 1 guest');
    expect(all.find((r) => r.title === 'Drives')?.description).toBe('1 drive owned by N and who can see them');
  });

  it('hides the attention group when nothing is waiting', () => {
    const sections = orgHubSections({ orgId: 'o1', orgName: 'N', role: 'ADMIN', counts: { ...counts, guestApprovals: 0, ownerLeftAutomations: 0 }, billingEnabled: true });
    expect(titles(sections)).not.toContain('Needs your attention');
  });

  it('shows only the waiting kinds in the attention group', () => {
    const sections = orgHubSections({ orgId: 'o1', orgName: 'N', role: 'ADMIN', counts: { ...counts, guestApprovals: 0 }, billingEnabled: true });
    expect(sections[0].rows.map((r) => r.title)).toEqual(['Automations whose owner left']);
  });

  it('SEAT-6 (partial): hides Billing entirely where billing is off (onprem, tenant)', () => {
    const sections = orgHubSections({ orgId: 'o1', orgName: 'N', role: 'OWNER', counts, billingEnabled: false });
    expect(titles(sections)).not.toContain('Billing');
  });

  it('describes counts that have not loaded without inventing numbers', () => {
    const all = orgHubSections({ orgId: 'o1', orgName: 'N', role: 'ADMIN', counts: {}, billingEnabled: true }).flatMap((s) => s.rows);
    expect(all.find((r) => r.title === 'Members & seats')?.description).toBe('Who is in N, invitations, and guests');
    expect(all.find((r) => r.title === 'Members & seats')?.badge).toBeUndefined();
    expect(all.find((r) => r.title === 'Drives')?.description).toBe('Drives owned by N and who can see them');
  });

  it('marks Backups as not available yet', () => {
    const backups = orgHubSections({ orgId: 'o1', orgName: 'N', role: 'ADMIN', counts, billingEnabled: true }).flatMap((s) => s.rows).find((r) => r.title === 'Backups');
    expect(backups?.available).toBe(false);
  });

  it('puts the renewal date on Plan & seats when it is known', () => {
    const plan = (renewal?: string) => orgHubSections({ orgId: 'o1', orgName: 'N', role: 'ADMIN', counts, billingEnabled: true, renewalLabel: renewal })
      .flatMap((s) => s.rows).find((r) => r.title === 'Plan & seats');
    expect(plan('Renews Oct 1')?.badge).toBe('Renews Oct 1');
    expect(plan()?.badge).toBeUndefined();
  });
});

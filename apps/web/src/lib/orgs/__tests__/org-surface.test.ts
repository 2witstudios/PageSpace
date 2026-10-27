import { describe, it, expect } from 'vitest';
import { orgIdForSurface } from '../org-surface';

const MEMBER_OF = (orgId: string) => orgId === 'org_1';
const drives = [
  { id: 'd_org', orgId: 'org_1' },
  { id: 'd_personal', orgId: null },
  { id: 'd_legacy' },
];

describe('orgIdForSurface', () => {
  it('SEAT-9 (partial) every org page is an org surface: the hub, each settings page, the Drives directory', () => {
    expect(orgIdForSurface(MEMBER_OF, '/orgs/org_1/settings', drives)).toBe('org_1');
    expect(orgIdForSurface(MEMBER_OF, '/orgs/org_1/settings/members', drives)).toBe('org_1');
    expect(orgIdForSurface(MEMBER_OF, '/orgs/org_1/drives', drives)).toBe('org_1');
  });

  it('SEAT-9 (partial) an open org drive is an org surface: its dashboard, pages, settings and members', () => {
    expect(orgIdForSurface(MEMBER_OF, '/dashboard/d_org', drives)).toBe('org_1');
    expect(orgIdForSurface(MEMBER_OF, '/dashboard/d_org/page_1', drives)).toBe('org_1');
    expect(orgIdForSurface(MEMBER_OF, '/dashboard/d_org/settings/general', drives)).toBe('org_1');
    expect(orgIdForSurface(MEMBER_OF, '/dashboard/d_org/members', drives)).toBe('org_1');
  });

  it('a personal drive, an unknown drive and every other page are not', () => {
    expect(orgIdForSurface(MEMBER_OF, '/dashboard/d_personal/page_1', drives)).toBeNull();
    expect(orgIdForSurface(MEMBER_OF, '/dashboard/d_legacy', drives)).toBeNull();
    expect(orgIdForSurface(MEMBER_OF, '/dashboard/d_unknown', drives)).toBeNull();
    expect(orgIdForSurface(MEMBER_OF, '/dashboard', drives)).toBeNull();
    expect(orgIdForSurface(MEMBER_OF, '/settings/usage/wallets', drives)).toBeNull();
    expect(orgIdForSurface(MEMBER_OF, '/orgs', drives)).toBeNull();
    expect(orgIdForSurface(MEMBER_OF, null, drives)).toBeNull();
  });

  it('SEAT-9 (partial) a guest on an org drive, or someone viewing an org they are not in, has no org surface: the org is never asked for', () => {
    const notAMember = () => false;
    expect(orgIdForSurface(notAMember, '/dashboard/d_org/page_1', drives)).toBeNull();
    expect(orgIdForSurface(notAMember, '/orgs/org_1/settings', drives)).toBeNull();
    expect(orgIdForSurface(MEMBER_OF, '/orgs/org_2/settings', drives)).toBeNull();
  });
});

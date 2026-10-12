import { describe, it, expect } from 'vitest';
import { orgIdForSurface } from '../org-surface';

const drives = [
  { id: 'd_org', orgId: 'org_1' },
  { id: 'd_personal', orgId: null },
  { id: 'd_legacy' },
];

describe('orgIdForSurface', () => {
  it('SEAT-9 (partial) every org page is an org surface: the hub, each settings page, the Drives directory', () => {
    expect(orgIdForSurface('/orgs/org_1/settings', drives)).toBe('org_1');
    expect(orgIdForSurface('/orgs/org_1/settings/members', drives)).toBe('org_1');
    expect(orgIdForSurface('/orgs/org_1/drives', drives)).toBe('org_1');
  });

  it('SEAT-9 (partial) an open org drive is an org surface: its dashboard, pages, settings and members', () => {
    expect(orgIdForSurface('/dashboard/d_org', drives)).toBe('org_1');
    expect(orgIdForSurface('/dashboard/d_org/page_1', drives)).toBe('org_1');
    expect(orgIdForSurface('/dashboard/d_org/settings/general', drives)).toBe('org_1');
    expect(orgIdForSurface('/dashboard/d_org/members', drives)).toBe('org_1');
  });

  it('a personal drive, an unknown drive and every other page are not', () => {
    expect(orgIdForSurface('/dashboard/d_personal/page_1', drives)).toBeNull();
    expect(orgIdForSurface('/dashboard/d_legacy', drives)).toBeNull();
    expect(orgIdForSurface('/dashboard/d_unknown', drives)).toBeNull();
    expect(orgIdForSurface('/dashboard', drives)).toBeNull();
    expect(orgIdForSurface('/settings/usage/wallets', drives)).toBeNull();
    expect(orgIdForSurface('/orgs', drives)).toBeNull();
    expect(orgIdForSurface(null, drives)).toBeNull();
  });
});

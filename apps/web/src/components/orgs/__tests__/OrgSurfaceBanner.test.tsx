import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgBillingNotice } from '@pagespace/lib/organizations/status-core';

const mocks = vi.hoisted(() => ({
  pathname: '/',
  drives: [] as { id: string; orgId: string | null }[],
  orgs: {} as Record<string, { role: 'OWNER' | 'ADMIN' | 'MEMBER'; billingNotice?: OrgBillingNotice }>,
  useOrg: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('@/components/billing/StripeProvider', () => ({ StripeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../OrgPaymentForm', () => ({ OrgPaymentForm: () => null }));
vi.mock('@/hooks/useDrive', () => ({ useDriveStore: (select: (s: { drives: typeof mocks.drives }) => unknown) => select({ drives: mocks.drives }) }));
vi.mock('@/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ refresh: vi.fn() }) }));
vi.mock('@/hooks/useOrgs', () => ({ useOrg: mocks.useOrg }));

import { OrgSurfaceBanner } from '../OrgSurfaceBanner';

const reactivate: OrgBillingNotice = { kind: 'reactivate', reason: 'canceled', canManageBilling: true };
const readOnly: OrgBillingNotice = { kind: 'read_only', canManageBilling: false };

/** GET /api/orgs/[orgId] as the route answers it: the notice is per viewer role (orgBillingNotice). */
function serve(orgId: string, notice: OrgBillingNotice | undefined) {
  mocks.useOrg.mockImplementation((id: string | undefined) => ({
    org: id === orgId
      ? { organization: { id: orgId, name: 'Northwind Labs' }, viewer: { role: 'ADMIN' }, ...(notice ? { billingNotice: notice } : {}) }
      : undefined,
    mutate: vi.fn(),
  }));
}

const shows = (path: string) => {
  mocks.pathname = path;
  const view = render(<OrgSurfaceBanner />);
  const result = {
    reactivate: screen.queryByRole('button', { name: 'Reactivate' }) !== null,
    readOnly: screen.queryByText('Northwind Labs is read-only') !== null,
    any: screen.queryByRole('status') !== null,
  };
  view.unmount();
  return result;
};

const ORG_SURFACES = [
  '/orgs/org_1/settings',
  '/orgs/org_1/settings/members',
  '/orgs/org_1/settings/billing',
  '/orgs/org_1/drives',
  '/dashboard/d_org',
  '/dashboard/d_org/page_1',
  '/dashboard/d_org/settings/general',
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.drives = [{ id: 'd_org', orgId: 'org_1' }, { id: 'd_personal', orgId: null }];
});

describe('the lapse banner on every org surface', () => {
  it('SEAT-9 (partial) Owner/Admin see the reactivate banner and Members the read-only notice on org settings AND org drive surfaces', () => {
    serve('org_1', reactivate);
    for (const path of ORG_SURFACES) expect(shows(path), path).toMatchObject({ reactivate: true, readOnly: false });

    serve('org_1', readOnly);
    for (const path of ORG_SURFACES) expect(shows(path), path).toMatchObject({ reactivate: false, readOnly: true });
  });

  it('a paid org, a personal drive and the rest of the app show nothing', () => {
    serve('org_1', undefined);
    expect(shows('/orgs/org_1/settings').any).toBe(false);
    serve('org_1', reactivate);
    expect(shows('/dashboard/d_personal/page_1').any).toBe(false);
    expect(shows('/dashboard').any).toBe(false);
    expect(shows('/settings/usage/wallets').any).toBe(false);
  });

  it('asks only for the org the surface belongs to', () => {
    serve('org_1', reactivate);
    shows('/dashboard/d_org/page_1');
    expect(mocks.useOrg).toHaveBeenCalledWith('org_1');
    vi.clearAllMocks();
    serve('org_1', reactivate);
    shows('/dashboard/d_personal');
    expect(mocks.useOrg).toHaveBeenCalledWith(undefined);
  });
});

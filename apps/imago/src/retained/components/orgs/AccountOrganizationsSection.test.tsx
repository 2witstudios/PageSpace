import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountOrganizationsSection } from './AccountOrganizationsSection';
const state = vi.hoisted(() => ({ orgs: [] as { id: string; name: string; slug: string; avatarUrl: null; role: 'MEMBER' }[], showBilling: true }));
vi.mock('@/retained/hooks/useOrgs', () => ({ useMyOrgs: () => ({ orgs: state.orgs, isLoading: false }), useOrgRealtime: () => {} }));
vi.mock('@/retained/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: state.showBilling }) }));
vi.mock('./CreateOrganizationDialog', () => ({ CreateOrganizationDialog: () => null }));
vi.mock('@/retained/lib/deployment-mode', () => ({ isBillingEnabled: () => true }));
beforeEach(() => { state.orgs = []; state.showBilling = true; });

describe('account organization surface', () => {
  test('a no-org account has only the Create affordance', () => {
    const markup = renderToStaticMarkup(<AccountOrganizationsSection />);
    expect(markup).not.toContain('>Organizations<');
    expect(markup).toContain('Create organization');
    expect(markup).not.toContain('/orgs/');
  });
  test('a member has their organization link under the native shell', () => {
    state.orgs = [{ id: 'org-1', name: 'Team', slug: 'team', avatarUrl: null, role: 'MEMBER' }];
    expect(renderToStaticMarkup(<AccountOrganizationsSection />)).toContain('href="/orgs/org-1/settings"');
  });
  test('a native no-org account without purchase visibility has no creation controls', () => {
    state.showBilling = false;
    expect(renderToStaticMarkup(<AccountOrganizationsSection />)).not.toContain('Create organization');
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  orgsEnabled: true,
  useMyOrgs: vi.fn(),
  useOrgRealtime: vi.fn(),
  showBilling: true,
  billingEnabled: true,
}));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return mocks.orgsEnabled;
  },
}));
vi.mock('@/hooks/useOrgs', () => ({ useMyOrgs: mocks.useMyOrgs, useOrgRealtime: mocks.useOrgRealtime }));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: mocks.showBilling }) }));
vi.mock('@/lib/deployment-mode', () => ({ isBillingEnabled: () => mocks.billingEnabled }));
vi.mock('../CreateOrganizationDialog', () => ({
  CreateOrganizationDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog">create dialog</div> : null),
}));

import { AccountOrganizationsSection } from '../AccountOrganizationsSection';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgsEnabled = true;
  mocks.showBilling = true;
  mocks.billingEnabled = true;
  mocks.useMyOrgs.mockReturnValue({
    orgs: [
      { id: 'o1', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, role: 'OWNER' },
      { id: 'o2', name: 'Acme', slug: 'acme', avatarUrl: null, role: 'MEMBER' },
    ],
    isLoading: false,
  });
});

describe('Account › Organizations', () => {
  it('UI-2 (partial): lists every membership with its role, each linking to its hub', () => {
    render(<AccountOrganizationsSection />);
    expect(screen.getByRole('heading', { name: 'Organizations' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Northwind Labs/ }).getAttribute('href')).toBe('/orgs/o1/settings');
    expect(screen.getByRole('link', { name: /Acme/ }).getAttribute('href')).toBe('/orgs/o2/settings');
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(screen.getByText('Member')).toBeTruthy();
  });

  it('UI-2 (partial): Create opens the create-organization dialog', async () => {
    render(<AccountOrganizationsSection />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Create organization/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('offers Create to someone in no org yet', () => {
    mocks.useMyOrgs.mockReturnValue({ orgs: [], isLoading: false });
    render(<AccountOrganizationsSection />);
    expect(screen.getByRole('button', { name: /Create organization/ })).toBeTruthy();
  });

  it('renders nothing while orgs are dark (ORGS_ENABLED false)', () => {
    mocks.orgsEnabled = false;
    const { container } = render(<AccountOrganizationsSection />);
    expect(container.innerHTML).toBe('');
  });

  it('hides Create where purchases are hidden (iOS), since creating takes a card', () => {
    mocks.showBilling = false;
    render(<AccountOrganizationsSection />);
    expect(screen.queryByRole('button', { name: /Create organization/ })).toBeNull();
  });

  it('keeps Create on a deployment without billing (onprem), where no card is asked', () => {
    mocks.billingEnabled = false;
    mocks.showBilling = false;
    render(<AccountOrganizationsSection />);
    expect(screen.getByRole('button', { name: /Create organization/ })).toBeTruthy();
  });
});

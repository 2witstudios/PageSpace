import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { visibility } = vi.hoisted(() => ({
  visibility: { showBilling: true, channel: 'stripe' as 'stripe' | 'apple' | 'none' },
}));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => visibility }));

import { UpgradeLink } from '../UpgradeLink';

describe('UpgradeLink', () => {
  beforeEach(() => {
    visibility.showBilling = true;
    visibility.channel = 'stripe';
  });

  it('given billing is visible, should link to the upgrade page', () => {
    render(<UpgradeLink href="/settings/plan" fallback="Available on paid plans">Upgrade to enable</UpgradeLink>);
    expect(screen.getByRole('link', { name: 'Upgrade to enable' }).getAttribute('href')).toBe('/settings/plan');
    expect(screen.queryByText('Available on paid plans')).toBeNull();
  });

  it('given no store may sell (old iOS binary, or detection not finished), should render the fallback and no link', () => {
    visibility.showBilling = false;
    visibility.channel = 'none';
    render(<UpgradeLink href="/settings/plan" fallback="Available on paid plans">Upgrade to enable</UpgradeLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Upgrade to enable')).toBeNull();
    expect(screen.getByText('Available on paid plans')).toBeTruthy();
  });

  it('given the Apple channel, should link to the in-app plan page (In-App Purchase)', () => {
    visibility.showBilling = false;
    visibility.channel = 'apple';
    render(<UpgradeLink href="/settings/plan" fallback="Available on paid plans">Upgrade to enable</UpgradeLink>);
    expect(screen.getByRole('link', { name: 'Upgrade to enable' }).getAttribute('href')).toBe('/settings/plan');
  });

  it('given the Apple channel, should never link to a Stripe page', () => {
    visibility.showBilling = false;
    visibility.channel = 'apple';
    render(<UpgradeLink href="/settings/billing" fallback="Available on paid plans">Upgrade to enable</UpgradeLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Available on paid plans')).toBeTruthy();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { visibility } = vi.hoisted(() => ({ visibility: { showBilling: true } }));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => visibility }));

import { UpgradeLink } from '../UpgradeLink';

describe('UpgradeLink', () => {
  beforeEach(() => {
    visibility.showBilling = true;
  });

  it('given billing is visible, should link to the upgrade page', () => {
    render(<UpgradeLink href="/settings/plan" fallback="Available on paid plans">Upgrade to enable</UpgradeLink>);
    expect(screen.getByRole('link', { name: 'Upgrade to enable' }).getAttribute('href')).toBe('/settings/plan');
    expect(screen.queryByText('Available on paid plans')).toBeNull();
  });

  it('given billing is hidden (iOS, or detection not finished), should render the fallback and no link', () => {
    visibility.showBilling = false;
    render(<UpgradeLink href="/settings/plan" fallback="Available on paid plans">Upgrade to enable</UpgradeLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Upgrade to enable')).toBeNull();
    expect(screen.getByText('Available on paid plans')).toBeTruthy();
  });
});

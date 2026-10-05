import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@/hooks/useAutomationSpendContext', () => ({
  useAutomationSpendContext: () => ({ creatorNames: { 'u-priya': 'Priya Nair' }, walletLabel: 'Product wallet', orgName: 'Northwind Labs' }),
}));

import { AutomationSkipNote, isSpendSkip } from '../AutomationSpendState';

describe('AutomationSkipNote: a trigger whose last run was skipped', () => {
  it('SPEND-6 (partial) a trigger refused at its creator\'s cap says so in the skip copy (D-OW-34)', () => {
    render(<AutomationSkipNote error="AI credit gate denied: source_refused (source_cap_reached)" driveId="d1" creatorId="u-priya" />);
    expect(screen.getByTestId('automation-skip-note').textContent).toBe('Skipped: Priya Nair reached their cap on Product wallet.');
  });

  it('SPEND-6 (partial) an empty wallet skip names the wallet', () => {
    render(<AutomationSkipNote error="AI credit gate denied: source_refused (drive_wallet_empty)" driveId="d1" />);
    expect(screen.getByTestId('automation-skip-note').textContent).toBe('Skipped: Product wallet was empty.');
  });

  it('SPEND-6 (partial) any other error is not a skip and renders nothing', () => {
    const { container } = render(<AutomationSkipNote error="Webhook returned 500" driveId="d1" />);
    expect(container.innerHTML).toBe('');
    expect(isSpendSkip('Webhook returned 500')).toBe(false);
    expect(isSpendSkip('AI credit gate denied: source_refused (creator_departed)')).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';

const { visibility } = vi.hoisted(() => ({ visibility: { showBilling: true } }));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => visibility }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ pulse: { enabled: false }, memory: { enabled: false, available: false } }),
    }),
  patch: vi.fn(),
}));

import { AutomationsCard } from '../AutomationsCard';

const renderCard = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AutomationsCard />
    </SWRConfig>,
  );

describe('AutomationsCard — locked Memory', () => {
  beforeEach(() => {
    visibility.showBilling = true;
  });

  it('given a free user on the web, should link to the plan page', async () => {
    renderCard();
    expect((await screen.findByRole('link', { name: /upgrade/i })).getAttribute('href')).toBe('/settings/plan');
  });

  it('given a free user in the iOS app, should say paid plans with no purchase link', async () => {
    visibility.showBilling = false;
    renderCard();
    expect(await screen.findByText(/available on paid plans/i)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

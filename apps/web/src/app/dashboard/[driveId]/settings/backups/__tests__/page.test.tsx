import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';

vi.mock('next/navigation', () => ({
  useParams: () => ({ driveId: 'drive-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { visibility } = vi.hoisted(() => ({ visibility: { showBilling: true } }));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => visibility }));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (url: string) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          url.includes('/schedule')
            ? { available: false, enabled: false, frequency: 'daily', timezone: 'UTC', nextRunAt: null, lastRunAt: null }
            : { backups: [], pagination: { total: 0, limit: 10, offset: 0, hasMore: false } },
        ),
    }),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: (selector: (s: unknown) => unknown) =>
    selector({
      drives: [{ id: 'drive-1', name: 'Acme', isOwned: true, role: 'OWNER' }],
      isLoading: false,
      fetchDrives: vi.fn(),
    }),
}));

import DriveBackupsPage from '../page';

const renderPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DriveBackupsPage />
    </SWRConfig>,
  );

describe('DriveBackupsPage — locked automatic backups', () => {
  beforeEach(() => {
    visibility.showBilling = true;
  });

  it('given a free user on the web, should link to the plan page', async () => {
    renderPage();
    expect((await screen.findByRole('link', { name: /upgrade to enable/i })).getAttribute('href')).toBe('/settings/plan');
  });

  it('given a free user in the iOS app, should say paid plans with no purchase link', async () => {
    visibility.showBilling = false;
    renderPage();
    expect(await screen.findByText(/available on paid plans/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /upgrade/i })).not.toBeInTheDocument();
  });
});

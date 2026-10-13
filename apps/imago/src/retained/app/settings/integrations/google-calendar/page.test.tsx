// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import GoogleCalendarSettingsPage from './page';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';

vi.mock('@/retained-adapters/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  imagoBrowserPath: (path: string) => path,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/retained/lib/navigation/oauth-redirect', () => ({
  startThirdPartyOAuth: vi.fn(),
}));

const calendars = [
  { id: 'cal-primary', summary: 'jono@studio.example', description: null, timeZone: 'America/Los_Angeles', backgroundColor: null, foregroundColor: null, primary: true, accessRole: 'owner' },
  { id: 'cal-team', summary: 'Studio Team', description: null, timeZone: 'America/Los_Angeles', backgroundColor: null, foregroundColor: null, primary: false, accessRole: 'writer' },
  { id: 'cal-hol', summary: 'Holidays in United States', description: null, timeZone: null, backgroundColor: null, foregroundColor: null, primary: false, accessRole: 'reader' },
];

const statusFor = (connection: Record<string, unknown> | null) => ({
  connected: connection?.status === 'active',
  connection: connection && {
    id: 'gc1',
    statusMessage: null,
    googleEmail: 'jono@studio.example',
    selectedCalendars: ['cal-primary', 'cal-team'],
    syncFrequencyMinutes: 15,
    targetDriveId: null,
    lastSyncAt: null,
    lastSyncError: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    status: 'active',
    ...connection,
  },
  syncedEventCount: 128,
});

const setup = ({ connection = { status: 'active' } as Record<string, unknown> | null } = {}) => {
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
    const body = url.endsWith('/status')
      ? statusFor(connection)
      : url.endsWith('/calendars')
        ? { calendars }
        : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return render(<GoogleCalendarSettingsPage />);
};

describe('GoogleCalendarSettingsPage (/account/integrations/google-calendar)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  test('renders the board h1, lede and no Back to Settings button', async () => {
    setup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Google Calendar');
    expect(screen.queryByRole('button', { name: /back to settings/i })).toBeNull();
  });

  test('a connected account shows Account, sync cadence, events and the Sync now and Disconnect actions', async () => {
    setup();
    const connection = await screen.findByRole('region', { name: 'Connection' });
    expect(within(connection).getByText('jono@studio.example')).toBeTruthy();
    expect(within(connection).getByText('every 15 min')).toBeTruthy();
    expect(within(connection).getByText('128')).toBeTruthy();
    expect(within(connection).getByText('Your personal calendar')).toBeTruthy();
    expect(within(connection).getByRole('button', { name: 'Sync now' })).toBeTruthy();
    expect(within(connection).getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  test('renders each calendar as a checkbox row with its time zone and role', async () => {
    setup();
    const section = await screen.findByRole('region', { name: 'Calendars' });
    expect(await within(section).findByRole('checkbox', { name: /Studio Team/ })).toBeTruthy();
    expect(within(section).getByText('America/Los_Angeles · writer')).toBeTruthy();
    expect(within(section).getByText('(primary)')).toBeTruthy();
  });

  test('a holiday calendar that is not selected stays unchecked', async () => {
    setup();
    const section = await screen.findByRole('region', { name: 'Calendars' });
    const holidays = await within(section).findByRole('checkbox', { name: /Holidays in United States/ });
    expect((holidays as HTMLInputElement).getAttribute('aria-checked')).toBe('false');
  });

  test('a sync error is shown from lastSyncError', async () => {
    setup({ connection: { status: 'active', lastSyncError: 'quota exceeded' } });
    expect(await screen.findByText('Last sync failed: quota exceeded')).toBeTruthy();
  });

  test('an expired connection needs reauth and offers Reconnect instead of Sync now', async () => {
    setup({ connection: { status: 'expired' } });
    expect(await screen.findByText('Google needs you to sign in again before events can sync.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  test('a disconnected account shows the connect call to action and no calendars', async () => {
    setup({ connection: null });
    expect(await screen.findByRole('button', { name: 'Connect Google Calendar' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Calendars' })).toBeNull();
  });
});

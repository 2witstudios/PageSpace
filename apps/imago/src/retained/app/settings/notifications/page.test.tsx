// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';
import NotificationsSettingsPage from './page';
import { fetchWithAuth, patch } from '@/retained/lib/auth/auth-fetch';
import { useToastPreferences } from '@/retained/hooks/useToastPreferences';
import type { ToastNotificationLevel } from '@/retained/lib/notifications/toast-eligible-types';

vi.mock('@/retained/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'jono@studio.example' }, isLoading: false }),
}));

vi.mock('@/retained-adapters/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('@/retained/hooks/useToastPreferences', () => ({
  useToastPreferences: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const patchMock = vi.mocked(patch);
const toastMock = vi.mocked(useToastPreferences);

const ALL_TYPES = [
  'NEW_DIRECT_MESSAGE',
  'PERMISSION_GRANTED',
  'PAGE_SHARED',
  'PERMISSION_UPDATED',
  'PERMISSION_REVOKED',
  'DRIVE_INVITED',
  'DRIVE_JOINED',
  'DRIVE_ROLE_CHANGED',
  'CONNECTION_REQUEST',
  'CONNECTION_ACCEPTED',
  'CONNECTION_REJECTED',
  'PRODUCT_UPDATE',
] as const;

const respondWithEmailPrefs = (overrides: Partial<Record<(typeof ALL_TYPES)[number], boolean>> = {}) => {
  const preferences = ALL_TYPES.map((notificationType) => ({
    notificationType,
    emailEnabled: overrides[notificationType] ?? true,
  }));
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ preferences }),
  } as unknown as Response);
};

const setPopupLevel = (level: ToastNotificationLevel) => {
  const updateLevel = vi.fn(async () => undefined);
  toastMock.mockReturnValue({ level, isLoading: false, updateLevel });
  return updateLevel;
};

const renderPage = async () => {
  const view = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <NotificationsSettingsPage />
    </SWRConfig>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Notifications' });
  return view;
};

describe('NotificationsSettingsPage (/account/notifications)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchMock.mockResolvedValue({} as Response);
  });

  afterEach(() => {
    cleanup();
  });

  test.each([
    ['All', 'all'],
    ['Mentions & DMs', 'mentions'],
    ['Off', 'off'],
  ] as const)('pop-up radio "%s" is checked when the level is %s', async (label, level) => {
    respondWithEmailPrefs();
    setPopupLevel(level);
    await renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Pop-up level' });
    const checked = within(group)
      .getAllByRole('radio')
      .filter((radio) => radio.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(within(group).getByRole('radio', { name: label }).getAttribute('aria-checked')).toBe('true');
  });

  test.each([
    ['All', 'all'],
    ['Mentions & DMs', 'mentions'],
    ['Off', 'off'],
  ] as const)('choosing "%s" updates the level to %s', async (label, level) => {
    respondWithEmailPrefs();
    // Radix does not report a click on the already-selected item, so start elsewhere.
    const updateLevel = setPopupLevel(level === 'all' ? 'mentions' : 'all');
    await renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Pop-up level' });
    fireEvent.click(within(group).getByRole('radio', { name: label }));
    await waitFor(() => {
      expect(updateLevel).toHaveBeenCalledWith(level);
    });
  });

  test('renders the twelve email switches in five named groups, each labelled Email: {label}', async () => {
    respondWithEmailPrefs();
    setPopupLevel('mentions');
    await renderPage();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(12);
    for (const name of [
      'Email: New direct message',
      'Email: Added as collaborator',
      'Email: Page shared',
      'Email: Permissions updated',
      'Email: Access removed',
      'Email: Added to workspace',
      'Email: Joined workspace',
      'Email: Role changed',
      'Email: Connection request',
      'Email: Connection accepted',
      'Email: Connection declined',
      'Email: Product announcements',
    ]) {
      expect(screen.getByRole('switch', { name })).toBeTruthy();
    }
    for (const group of ['Direct messages', 'Collaboration', 'Workspaces', 'Connections', 'Product updates']) {
      expect(screen.getByRole('heading', { level: 3, name: group })).toBeTruthy();
    }
  });

  test('email section names the account address it sends to', async () => {
    respondWithEmailPrefs();
    setPopupLevel('mentions');
    await renderPage();
    expect(screen.getByRole('region', { name: 'Email' }).textContent).toContain('Sent to jono@studio.example.');
  });

  test('an email switch shows its stored state and persists the toggle', async () => {
    respondWithEmailPrefs({ PAGE_SHARED: false });
    setPopupLevel('mentions');
    await renderPage();
    const sw = screen.getByRole('switch', { name: 'Email: Page shared' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/api/settings/notification-preferences', {
        notificationType: 'PAGE_SHARED',
        emailEnabled: true,
      });
    });
  });

  test('a switch with no stored preference defaults to on', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ preferences: [] }) } as unknown as Response);
    setPopupLevel('mentions');
    await renderPage();
    expect(screen.getByRole('switch', { name: 'Email: Product announcements' }).getAttribute('aria-checked')).toBe('true');
  });

  test('no Back to Settings button and a single h1', async () => {
    respondWithEmailPrefs();
    setPopupLevel('mentions');
    await renderPage();
    expect(screen.queryByRole('button', { name: /back to settings/i })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

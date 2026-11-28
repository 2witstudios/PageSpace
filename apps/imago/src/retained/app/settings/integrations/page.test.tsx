// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import IntegrationsSettingsPage from './page';
import { useAuth } from '@/retained/hooks/useAuth';
import {
  useAvailableBuiltins,
  useGoogleCalendarStatus,
  useProviders,
  useUserConnections,
} from '@/retained/hooks/useIntegrations';

vi.mock('@/retained/hooks/useAuth', () => ({ useAuth: vi.fn() }));

vi.mock('@/retained-adapters/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/retained/hooks/useIntegrations', () => ({
  useProviders: vi.fn(),
  useUserConnections: vi.fn(),
  useAvailableBuiltins: vi.fn(),
  useGoogleCalendarStatus: vi.fn(),
}));

vi.mock('@/retained/components/integrations/ConnectIntegrationDialog', () => ({
  ConnectIntegrationDialog: () => null,
}));

vi.mock('@/retained/components/integrations/DisconnectConfirmDialog', () => ({
  DisconnectWithAgentCount: () => null,
}));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  del: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
  post: vi.fn(async () => ({})),
}));

const github = {
  id: 'conn-github',
  providerId: 'prov-github',
  name: 'GitHub',
  status: 'active',
  statusMessage: null,
  visibility: 'owned_drives',
  accountMetadata: { accountName: '@jono-studio' },
  baseUrlOverride: null,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  provider: { id: 'prov-github', slug: 'github', name: 'GitHub', description: null },
} as const;

const slack = {
  ...github,
  id: 'conn-slack',
  providerId: 'prov-slack',
  name: 'Slack',
  status: 'expired',
  visibility: 'all_drives',
  accountMetadata: { workspaceName: 'studio.slack.com' },
  provider: { id: 'prov-slack', slug: 'slack', name: 'Slack', description: null },
} as const;

const providers = [
  { id: 'prov-github', slug: 'github', name: 'GitHub', description: null },
  { id: 'prov-notion', slug: 'notion', name: 'Notion', description: 'Search and update pages.' },
];

const setup = ({
  role = 'member',
  connections = [github, slack],
  gcalConnection = null,
  builtins = [],
}: {
  role?: 'member' | 'admin';
  connections?: unknown[];
  gcalConnection?: { status: string; googleEmail: string; lastSyncAt: null } | null;
  builtins?: { id: string; name: string; description: string | null; documentationUrl: null }[];
} = {}) => {
  vi.mocked(useAuth).mockReturnValue({ user: { id: 'me', role } } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(useProviders).mockReturnValue({
    providers,
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
  } as unknown as ReturnType<typeof useProviders>);
  vi.mocked(useUserConnections).mockReturnValue({
    connections,
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
  } as unknown as ReturnType<typeof useUserConnections>);
  vi.mocked(useAvailableBuiltins).mockReturnValue({
    builtins,
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
  } as unknown as ReturnType<typeof useAvailableBuiltins>);
  vi.mocked(useGoogleCalendarStatus).mockReturnValue({
    connected: gcalConnection?.status === 'active',
    connection: gcalConnection,
    syncedEventCount: 0,
    error: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useGoogleCalendarStatus>);
  return render(<IntegrationsSettingsPage />);
};

describe('IntegrationsSettingsPage (/account/integrations)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  test('renders one h1 and no Back to Settings button', () => {
    setup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Integrations');
    expect(screen.queryByRole('button', { name: /back to settings/i })).toBeNull();
  });

  test('renders each connected row with its visibility select and disconnect action', () => {
    setup();
    const section = screen.getByRole('region', { name: 'Connected 2' });
    expect(within(section).getByRole('combobox', { name: 'Visibility for GitHub' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Disconnect GitHub' })).toBeTruthy();
    expect(within(section).getByText('@jono-studio')).toBeTruthy();
  });

  test('an expired connection shows Reconnect and its status pill', () => {
    setup();
    const section = screen.getByRole('region', { name: 'Connected 2' });
    expect(within(section).getByRole('button', { name: 'Reconnect Slack' })).toBeTruthy();
    expect(within(section).getByText('Expired')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Reconnect GitHub' })).toBeNull();
  });

  test('a connected Google Calendar row offers Manage and Disconnect', () => {
    setup({
      gcalConnection: { status: 'active', googleEmail: 'jono@studio.example', lastSyncAt: null },
    });
    const section = screen.getByRole('region', { name: 'Connected 3' });
    expect(within(section).getByText('Google Calendar')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Manage Google Calendar' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Disconnect Google Calendar' })).toBeTruthy();
  });

  test('renders available providers with Connect', () => {
    setup({ role: 'admin' });
    const section = screen.getByRole('region', { name: 'Available providers' });
    expect(within(section).getByText('Notion')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Connect' })).toBeTruthy();
  });

  test('members do not see the built-in integrations section', () => {
    setup({ role: 'member', builtins: [{ id: 'b1', name: 'Notion', description: null, documentationUrl: null }] });
    expect(screen.queryByRole('region', { name: 'Built-in integrations' })).toBeNull();
  });

  test('admins see built-in integrations with Install', () => {
    setup({ role: 'admin', builtins: [{ id: 'b1', name: 'Generic Webhook', description: null, documentationUrl: null }] });
    const section = screen.getByRole('region', { name: 'Built-in integrations' });
    expect(within(section).getByText('Admin')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Install' })).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { DriveIntegrations } from './DriveIntegrations';

const provider = (id: string, slug: string, name: string) => ({ id, slug, name, description: null });
const connection = (id: string, name: string, status: 'active' | 'expired', providerRow: ReturnType<typeof provider>) => ({
  id,
  providerId: providerRow.id,
  name,
  status,
  statusMessage: null,
  accountMetadata: null,
  baseUrlOverride: null,
  lastUsedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  provider: providerRow,
});

const github = provider('p-gh', 'github', 'GitHub');
const notion = provider('p-notion', 'notion', 'Notion');
const CONNECTIONS = [
  connection('c1', 'studio-web', 'active', github),
  connection('c2', 'Research', 'expired', notion),
];
const GRANTS: Record<string, number> = { c1: 2, c2: 1 };

const spies = vi.hoisted(() => ({ useDriveConnections: vi.fn(), useProviders: vi.fn(), useConnectionGrantCount: vi.fn() }));

vi.mock('@/retained/hooks/useIntegrations', () => ({
  useDriveConnections: spies.useDriveConnections,
  useProviders: spies.useProviders,
  useConnectionGrantCount: spies.useConnectionGrantCount,
}));
vi.mock('@/retained/hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'user' } }) }));
vi.mock('@/retained/components/integrations/ConnectIntegrationDialog', () => ({ ConnectIntegrationDialog: () => null }));
vi.mock('@/retained/components/integrations/DisconnectConfirmDialog', () => ({ DisconnectWithAgentCount: () => null }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ del: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(unmountAll);

const useStubs = (connections = CONNECTIONS) => {
  spies.useDriveConnections.mockReturnValue({ connections, isLoading: false, error: undefined, mutate: vi.fn() });
  spies.useProviders.mockReturnValue({ providers: [github, notion], isLoading: false, error: undefined, mutate: vi.fn() });
  spies.useConnectionGrantCount.mockImplementation((id: string) => ({ count: GRANTS[id] ?? 0, isLoading: false, error: undefined }));
};

describe('DriveIntegrations', () => {
  test('lists each connection with its provider, agent count and a Disconnect action', () => {
    useStubs();
    const container = mount(<DriveIntegrations driveId="d1" />);
    const text = container.textContent ?? '';
    assert({
      given: 'an active GitHub connection and an expired Notion one',
      should: 'show the heading, each name with "provider · N agents", and a Disconnect for each',
      actual: {
        heading: container.querySelector('h2')?.textContent,
        names: ['studio-web', 'Research'].map((name) => text.includes(name)),
        providerLines: ['GitHub · 2 agents', 'Notion · 1 agent'].map((line) => text.includes(line)),
        disconnects: [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Disconnect').length,
      },
      expected: {
        heading: 'Connected',
        names: [true, true],
        providerLines: [true, true],
        disconnects: 2,
      },
    });
  });

  test('an expired connection is shown as Expired, with no Reconnect action (no re-auth route exists yet)', () => {
    useStubs();
    const container = mount(<DriveIntegrations driveId="d1" />);
    const reconnects = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Reconnect').length;
    assert({
      given: 'a connection whose status is expired',
      should: 'show the Expired badge and no Reconnect button until a drive re-auth route exists',
      actual: { expired: container.textContent?.includes('Expired') ?? false, reconnects },
      expected: { expired: true, reconnects: 0 },
    });
  });

  test('with no connections it shows the empty state rather than a list', () => {
    useStubs([]);
    const container = mount(<DriveIntegrations driveId="d1" />);
    assert({
      given: 'a drive with no connections',
      should: 'say that no integrations are connected and draw no group',
      actual: {
        text: container.textContent?.includes('No integrations connected to this drive.') ?? false,
        group: container.querySelector('[role="group"]') !== null,
      },
      expected: { text: true, group: false },
    });
  });
});

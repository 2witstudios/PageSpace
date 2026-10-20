// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';

const fixtures = vi.hoisted(() => {
  const session = (workspaceId: string, name: string, sandboxStatus: 'none' | 'running') => ({
    workspaceId,
    driveId: 'd1',
    envId: 'e1',
    name,
    sandboxStatus,
    createdAt: '2026-10-12T10:00:00.000Z',
    lastActiveAt: null,
    conversations: [],
    rev: 1,
    nodes: [],
    targets: [],
  });
  return {
    selection: { selectedSessionId: 's2' as string | null, selectSession: vi.fn() },
    sessions: [session('s1', 'Docs refresh', 'none'), session('s2', 'Ship status page', 'running')],
  };
});

vi.mock('@/retained/stores/agents/useAgentSurfaceStore', () => ({
  useAgentSurfaceStore: (select: (state: typeof fixtures.selection) => unknown) => select(fixtures.selection),
}));
vi.mock('@/retained/hooks/useDrive', () => ({
  useDriveStore: (select: (state: { drives: unknown[] }) => unknown) => select({ drives: [] }),
}));
vi.mock('@/retained/hooks/usePermissions', () => ({ canManageDrive: () => false }));
vi.mock('@/retained/hooks/drive-envs/useAppHostingCapability', () => ({ useAppHostingCapability: () => false }));
vi.mock('@/retained/hooks/page-agents/usePageAgents', () => ({ usePageAgents: () => ({ agentsByDrive: [] }) }));
vi.mock('@/retained/components/agents/useSpawnSession', () => ({
  useSpawnSession: () => ({ openSpawn: vi.fn(), paletteElement: null }),
}));
vi.mock('@/retained/hooks/drive-envs/useDriveEnvs', () => ({
  useDriveEnvs: () => ({
    envs: [{ id: 'e1', name: 'studio-web', substrate: 'sprite' }],
    isLoading: false,
    error: null,
    mutate: vi.fn(),
  }),
}));
vi.mock('./published-app-card', () => ({ PublishedAppCard: () => null }));
vi.mock('./agents-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agents-data')>();
  return {
    ...actual,
    useAgentSessions: () => ({ sessions: fixtures.sessions, isLoading: false, error: null, mutate: vi.fn() }),
    useDriveAgents: () => [{ id: 'a1', title: 'Launch Agent', aiModel: 'claude-sonnet-5-5' }],
    usePublishedAppPointers: () => [],
  };
});

const { AgentsPane } = await import('./agents-pane');

afterEach(unmountAll);

describe('AgentsPane (IMC-6.3)', () => {
  test('a pane headed Console, with a Session button and a session search', () => {
    const root = mount(<AgentsPane driveId="d1" close={null} />);
    assert({
      given: 'a drive with sessions',
      should: 'head the pane "Console" with a Session button and a "Search sessions…" field',
      actual: [
        root.querySelector('section[aria-label="Console: agents and sessions"]') !== null,
        Array.from(root.querySelectorAll('button')).some((button) => button.textContent === 'Session'),
        root.querySelector('input[aria-label="Search sessions"]')?.getAttribute('placeholder'),
      ],
      expected: [true, true, 'Search sessions…'],
    });
  });

  test('sessions group under their environment, with the selected one marked', () => {
    const root = mount(<AgentsPane driveId="d1" close={null} />);
    const group = root.querySelector('section[aria-label="studio-web"]');
    const current = group?.querySelector('[aria-current="true"]');
    assert({
      given: 'a session selected in the shared selection',
      should: 'list the sessions inside their environment group, mark the selected one aria-current, and mark the running one',
      actual: [
        group?.textContent?.includes('Sprite'),
        current?.textContent?.includes('Ship status page'),
        group?.querySelector('[aria-label="Sandbox running"]') !== null,
        group?.querySelectorAll('[aria-label="Sandbox running"]').length,
      ],
      expected: [true, true, true, 1],
    });
  });

  test('the Agents in the drive list their name and model', () => {
    const root = mount(<AgentsPane driveId="d1" close={null} />);
    assert({
      given: 'a drive with an agent',
      should: 'list it under "Agents in <drive>" with its name and model',
      actual: root.textContent?.includes('Launch Agent') && root.textContent?.includes('claude-sonnet-5-5'),
      expected: true,
    });
  });
});

// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';

const fixtures = vi.hoisted(() => {
  const session = (workspaceId: string, name: string, driveId: string, envId: string | null) => ({
    workspaceId,
    driveId,
    envId,
    name,
    sandboxStatus: 'running' as const,
    createdAt: '2026-10-12T10:00:00.000Z',
    lastActiveAt: null,
    conversations: [],
    rev: 1,
    nodes: [],
    targets: [],
  });
  const env = (id: string, name: string, status: 'running' | 'stopped' | 'none') => ({
    id,
    driveId: 'd1',
    name,
    createdAt: '2026-10-12T10:00:00.000Z',
    substrate: 'sprite' as const,
    status,
  });
  return {
    openSpawn: vi.fn(),
    selection: { selectedSessionId: 's2' as string | null, selectSession: vi.fn() },
    drives: [
      { id: 'home', name: 'Home' },
      { id: 'd1', name: 'Studio' },
      { id: 'd2', name: 'Ops' },
    ],
    sessions: [session('s1', 'Docs refresh', 'd1', 'e2'), session('s2', 'Ship status page', 'd1', 'e1')],
    envsByDrive: {
      d1: [env('e1', 'studio-web', 'running'), env('e2', 'Ephemeral', 'stopped')],
      d2: [],
    } as Record<string, ReturnType<typeof env>[]>,
  };
});

vi.mock('@/retained/stores/agents/useAgentSurfaceStore', () => ({
  useAgentSurfaceStore: (select: (state: typeof fixtures.selection) => unknown) => select(fixtures.selection),
}));
vi.mock('@/retained/hooks/useDrive', () => ({
  useDriveStore: (select: (state: { drives: unknown[]; fetchDrives: () => Promise<void> }) => unknown) =>
    select({ drives: fixtures.drives, fetchDrives: async () => {} }),
}));
vi.mock('@/retained/hooks/drive-envs/useDriveEnvs', () => ({
  useDriveEnvs: (driveId: string) => ({
    envs: fixtures.envsByDrive[driveId] ?? [],
    isLoading: false,
    error: null,
    mutate: vi.fn(),
  }),
}));
vi.mock('@/retained/hooks/page-agents/usePageAgents', () => ({ usePageAgents: () => ({ agentsByDrive: [] }) }));
vi.mock('@/retained/components/agents/useSpawnSession', () => ({
  useSpawnSession: () => ({ openSpawn: fixtures.openSpawn, paletteElement: null }),
}));
vi.mock('./agents-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agents-data')>();
  return {
    ...actual,
    useAgentSessions: () => ({ sessions: fixtures.sessions, isLoading: false, error: null, mutate: vi.fn() }),
  };
});

const { HomeConsolePane } = await import('./home-console-pane');

afterEach(unmountAll);

describe('HomeConsolePane (IMC-7.29)', () => {
  test('Home’s Console starts a session in Home', () => {
    const root = mount(<HomeConsolePane driveId="home" close={null} />);
    const pane = root.querySelector('[aria-label="Console: agents and sessions"]');
    const start = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Session');
    start?.click();
    assert({
      given: 'the every-drive Console on Home',
      should: 'head it Console, as on a drive, and open the new-session palette for Home',
      actual: [pane?.textContent?.startsWith('Console'), fixtures.openSpawn.mock.calls[0]],
      expected: [true, ['home', 'Home']],
    });
  });

  test('a pane with a search field, sessions grouped drive then environment', () => {
    const root = mount(<HomeConsolePane driveId="home" close={null} />);
    const drive = root.querySelector('section[aria-label="Studio"]');
    const env = drive?.querySelector('section[aria-label="studio-web"]');
    assert({
      given: 'sessions across drives and their environments',
      should: 'search "Search sessions…", and nest each environment under its drive',
      actual: [
        root.querySelector('input[aria-label="Search sessions"]')?.getAttribute('placeholder'),
        drive !== null && drive !== undefined,
        env?.textContent?.includes('Ship status page'),
      ],
      expected: ['Search sessions…', true, true],
    });
  });

  test('environments carry status dots labelled for their state', () => {
    const root = mount(<HomeConsolePane driveId="home" close={null} />);
    assert({
      given: 'a running and a stopped environment',
      should: 'label the dots Environment running and Environment stopped',
      actual: [
        root.querySelector('[role="img"][aria-label="Environment running"]') !== null,
        root.querySelector('[role="img"][aria-label="Environment stopped"]') !== null,
      ],
      expected: [true, true],
    });
  });

  test('the selected session is marked and an environment with no sessions says so', () => {
    const root = mount(<HomeConsolePane driveId="home" close={null} />);
    const current = root.querySelector('[aria-current="true"]');
    assert({
      given: 'the shared selection and an environment with no session',
      should: 'mark the selected session and read "No sessions running in here" under the empty environment',
      actual: [current?.textContent?.includes('Ship status page'), root.textContent?.includes('No sessions running in here')],
      expected: [true, false],
    });
  });

  test('a drive with no environments reads "No environments in this drive"', () => {
    const root = mount(<HomeConsolePane driveId="home" close={null} />);
    const emptyDrive = root.querySelector('section[aria-label="Ops"]');
    assert({
      given: 'a drive whose environment listing is empty',
      should: 'say No environments in this drive under its name',
      actual: emptyDrive?.textContent?.includes('No environments in this drive'),
      expected: true,
    });
  });
});

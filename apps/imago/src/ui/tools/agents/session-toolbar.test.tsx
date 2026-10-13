// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { useAgentPaneRequestStore } from '@/retained/stores/agent-workspace/useAgentPaneRequestStore';

type Session = { workspaceId: string; driveId: string; envId: string | null; name: string; sandboxStatus: string; createdAt: string; lastActiveAt: null; conversations: never[]; rev: number; nodes: never[]; targets: never[] };
const fixtures = vi.hoisted(() => ({
  selection: { selectedSessionId: null as string | null, selectedAgentId: 'a1' as string | null, selectSession: vi.fn() },
  record: { session: { driveId: 'd1', name: 'Ship status page' } as { driveId: string; name: string } | null, canEndSession: false },
  sessions: [] as Session[],
  agents: [{ id: 'a1', title: 'Launch Agent', aiModel: 'claude-sonnet-5-5' }] as { id: string; title: string; aiModel: string }[],
  refresh: vi.fn(),
  forget: vi.fn(),
  del: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  dialog: { props: null as null | { open: boolean; onOpenChange: (open: boolean) => void; sessionName: string | null; onConfirm: () => void } },
  envDrive: null as string | null | undefined,
}));

vi.mock('@/retained/stores/agents/useAgentSurfaceStore', () => ({
  useAgentSurfaceStore: (select: (state: typeof fixtures.selection) => unknown) => select(fixtures.selection),
}));
vi.mock('@/retained/stores/agent-workspace/useAgentWorkspaceStore', () => ({
  useAgentWorkspaceStore: { getState: () => ({ forgetWorkspace: fixtures.forget }) },
}));
vi.mock('@/retained/components/dev-preview/DevPreviewAffordance', () => ({ DevPreviewAffordance: () => null }));
vi.mock('@/retained/components/agents/EndSessionDialog', () => ({
  default: (props: NonNullable<typeof fixtures.dialog.props>) => {
    fixtures.dialog.props = props;
    return null;
  },
}));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ del: (...args: unknown[]) => fixtures.del(...args) }));
vi.mock('sonner', () => ({ toast: fixtures.toast }));
vi.mock('@/retained/hooks/drive-envs/useDriveEnvs', () => ({
  useDriveEnvs: (driveId: string | null) => { fixtures.envDrive = driveId; return { envs: [{ id: 'e1', name: 'studio-web', substrate: 'sprite' }], isLoading: false, error: null, mutate: vi.fn() }; },
}));
vi.mock('@/retained/components/agents/useSessionRecord', () => ({
  useSessionRecord: () => ({ data: fixtures.record }),
}));
vi.mock('./agents-data', () => ({
  useAgentSessions: () => ({ sessions: fixtures.sessions, isLoading: false, error: null, mutate: fixtures.refresh }),
  useDriveAgents: () => fixtures.agents,
}));

const { SessionToolbar } = await import('./session-toolbar');

const running: Session = {
  workspaceId: 's2',
  driveId: 'd1',
  envId: 'e1',
  name: 'Ship status page',
  sandboxStatus: 'running',
  createdAt: new Date(Date.now() - 42 * 60_000).toISOString(),
  lastActiveAt: null,
  conversations: [],
  rev: 1,
  nodes: [],
  targets: [],
};

beforeEach(() => {
  fixtures.sessions = [running];
  fixtures.record = { session: { driveId: 'd1', name: 'Ship status page' }, canEndSession: false };
  fixtures.agents = [{ id: 'a1', title: 'Launch Agent', aiModel: 'claude-sonnet-5-5' }];
  fixtures.selection.selectedAgentId = 'a1';
  fixtures.dialog.props = null;
  fixtures.envDrive = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  unmountAll();
  fixtures.selection.selectedSessionId = null;
});

describe('SessionToolbar (IMC-6.4)', () => {
  test('renders nothing until a session is selected', () => {
    const root = mount(<SessionToolbar driveId="d1" />);
    assert({
      given: 'no selected session',
      should: 'render no toolbar',
      actual: root.querySelector('[role="toolbar"]'),
      expected: null,
    });
  });

  test('reads the agent, environment, start and sandbox state of the selected session', () => {
    fixtures.selection.selectedSessionId = 's2';
    const root = mount(<SessionToolbar driveId="d1" />);
    const toolbar = root.querySelector('[role="toolbar"][aria-label="Session"]');
    assert({
      given: 'a running session with an agent selected',
      should: 'name it "<agent> · env <name> · started <ago>" beside a Sandbox running pill',
      actual: [
        toolbar?.textContent?.includes('Launch Agent · env studio-web · started 42 min ago'),
        toolbar?.textContent?.includes('Sandbox running'),
      ],
      expected: [true, true],
    });
  });

  test('End session is withheld from people who may not end the session', () => {
    fixtures.selection.selectedSessionId = 's2';
    const root = mount(<SessionToolbar driveId="d1" />);
    assert({
      given: 'a viewer the server does not allow to end the session',
      should: 'not offer End session',
      actual: Array.from(root.querySelectorAll('button')).some((button) => button.textContent === 'End session'),
      expected: false,
    });
  });

  test('Add pane asks the pane grid to open its picker for this session', () => {
    fixtures.selection.selectedSessionId = 's2';
    const before = useAgentPaneRequestStore.getState().addPane.s2 ?? 0;
    const root = mount(<SessionToolbar driveId="d1" />);
    const button = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Add pane');
    act(() => button?.click());
    assert({
      given: 'a click on Add pane',
      should: 'raise one add-pane request for the selected session',
      actual: (useAgentPaneRequestStore.getState().addPane.s2 ?? 0) - before,
      expected: 1,
    });
  });
  test('falls back through the session name, the record name and "Session" when the agent is unknown', () => {
    fixtures.selection.selectedSessionId = 's2';
    fixtures.selection.selectedAgentId = 'gone';
    const named = mount(<SessionToolbar driveId="d1" />).querySelector('[role="toolbar"] span')?.textContent;
    unmountAll();

    fixtures.sessions = [{ ...running, envId: null, sandboxStatus: 'stopped' }];
    const bare = mount(<SessionToolbar driveId="d1" />);
    const noEnv = bare.querySelector('[role="toolbar"]')?.textContent;
    unmountAll();

    fixtures.sessions = [];
    const fromRecord = mount(<SessionToolbar driveId="d1" />).querySelector('[role="toolbar"] span')?.textContent;
    unmountAll();

    fixtures.record = { session: null, canEndSession: false };
    const bareLabel = mount(<SessionToolbar />).querySelector('[role="toolbar"] span')?.textContent;
    assert({
      given: 'an agent that is no longer listed, then a session with no environment, then no session row, then no record',
      should: 'name the session, drop the env and the Sandbox pill, then the record name, then plain "Session"',
      actual: [
        named,
        noEnv?.includes('env '),
        noEnv?.includes('Sandbox running'),
        fromRecord,
        bareLabel,
      ],
      expected: [
        'Ship status page · env studio-web · started 42 min ago',
        false,
        false,
        'Ship status page',
        'Session',
      ],
    });
  });

  test('leaves the environment out when the session names one the drive does not have', () => {
    fixtures.selection.selectedSessionId = 's2';
    fixtures.sessions = [{ ...running, envId: 'missing' }];
    const root = mount(<SessionToolbar driveId="d1" />);
    assert({
      given: 'a session whose environment is not in the drive list',
      should: 'show the agent and start only',
      actual: root.querySelector('[role="toolbar"] span')?.textContent,
      expected: 'Launch Agent · started 42 min ago',
    });
  });

  test('looks up environments in the record\'s drive, else the pane\'s drive', () => {
    fixtures.selection.selectedSessionId = 's2';
    fixtures.record = { session: { driveId: 'd9', name: 'x' }, canEndSession: false };
    mount(<SessionToolbar driveId="d1" />);
    const fromRecord = fixtures.envDrive;
    unmountAll();
    fixtures.record = { session: null, canEndSession: false };
    mount(<SessionToolbar />);
    assert({
      given: 'a record with its own drive, then no record and no pane drive',
      should: 'ask for the record\'s drive first and for none when neither is known',
      actual: [fromRecord, fixtures.envDrive],
      expected: ['d9', null],
    });
  });

  test('End session asks first, then ends the session, forgets it and says so', async () => {
    fixtures.selection.selectedSessionId = 's2';
    fixtures.record = { session: { driveId: 'd1', name: 'Ship status page' }, canEndSession: true };
    fixtures.del.mockResolvedValue(undefined);
    const root = mount(<SessionToolbar driveId="d1" />);
    const button = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'End session');
    act(() => button?.click());
    const opened = fixtures.dialog.props?.open;
    await act(async () => fixtures.dialog.props?.onConfirm());
    assert({
      given: 'a viewer who may end the session, who opens the confirm and accepts it',
      should: 'open the dialog, DELETE the workspace, forget it, deselect it, toast success and refresh the list',
      actual: [
        opened,
        fixtures.dialog.props?.sessionName,
        fixtures.del.mock.calls,
        fixtures.forget.mock.calls,
        fixtures.selection.selectSession.mock.calls,
        fixtures.toast.success.mock.calls,
        fixtures.toast.error.mock.calls.length,
        fixtures.refresh.mock.calls.length,
      ],
      expected: [true, 'Ship status page', [['/api/agent-workspaces/s2']], [['s2']], [[null]], [['Session ended']], 0, 1],
    });
  });

  test('reports why ending failed, with a plain fallback for a non-Error', async () => {
    fixtures.selection.selectedSessionId = 's2';
    fixtures.sessions = [];
    fixtures.record = { session: null, canEndSession: true };
    fixtures.del.mockRejectedValueOnce(new Error('Sandbox is busy')).mockRejectedValueOnce('boom');
    mount(<SessionToolbar driveId="d1" />);
    await act(async () => fixtures.dialog.props?.onConfirm());
    await act(async () => fixtures.dialog.props?.onConfirm());
    assert({
      given: 'a server refusal, then a rejection that is not an Error',
      should: 'toast the error message, then "Please try again.", and refresh the list both times',
      actual: [fixtures.toast.error.mock.calls, fixtures.refresh.mock.calls.length, fixtures.dialog.props?.sessionName],
      expected: [
        [
          ['Could not end the session', { description: 'Sandbox is busy' }],
          ['Could not end the session', { description: 'Please try again.' }],
        ],
        2,
        null,
      ],
    });
  });
});

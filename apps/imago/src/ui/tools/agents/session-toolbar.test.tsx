// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { useAgentPaneRequestStore } from '@/retained/stores/agent-workspace/useAgentPaneRequestStore';

type Session = { workspaceId: string; driveId: string; envId: string | null; name: string; sandboxStatus: string; createdAt: string; lastActiveAt: null; conversations: never[]; rev: number; nodes: never[]; targets: never[] };
const fixtures = vi.hoisted(() => ({
  selection: { selectedSessionId: null as string | null, selectSession: vi.fn() },
  record: { session: { driveId: 'd1', name: 'Ship status page' } as { driveId: string; name: string } | null, canEndSession: false },
  sessions: [] as Session[],
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
  fixtures.dialog.props = null;
  fixtures.envDrive = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  unmountAll();
  fixtures.selection.selectedSessionId = null;
});

describe('SessionToolbar (C-Drive-Agents session bar)', () => {
  const toolbar = (root: HTMLElement) => root.querySelector('[role="toolbar"][aria-label="Session"]');
  const nameOf = (root: HTMLElement) => root.querySelector('[data-session-name]')?.textContent;
  const metaOf = (root: HTMLElement) => root.querySelector('[data-session-meta]')?.textContent;
  const buttonNamed = (root: HTMLElement, label: string) =>
    Array.from(root.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === label || b.textContent === label);

  test('renders nothing until a session is selected', () => {
    const root = mount(<SessionToolbar driveId="d1" />);
    assert({
      given: 'no selected session',
      should: 'render no session bar',
      actual: toolbar(root),
      expected: null,
    });
  });

  test('names the session, where it runs and when it started, beside its sandbox state', () => {
    fixtures.selection.selectedSessionId = 's2';
    const root = mount(<SessionToolbar driveId="d1" />);
    assert({
      given: 'a running session in an environment',
      should: 'read "<name>", "in <env> · started <ago>" and mark the sandbox running',
      actual: [
        nameOf(root),
        metaOf(root),
        root.querySelector('[role="img"][aria-label="Sandbox running"]') !== null,
      ],
      expected: ['Ship status page', 'in studio-web · started 42 min ago', true],
    });
  });

  test('carries the shell controls it is handed: Show sidebar first, the Ask pill before Close', () => {
    fixtures.selection.selectedSessionId = 's2';
    const root = mount(
      <SessionToolbar driveId="d1" leading={<button type="button">Show sidebar</button>} trailing={<button type="button">Ask</button>} />,
    );
    const labels = Array.from(toolbar(root)?.querySelectorAll('button') ?? []).map((b) => b.getAttribute('aria-label') ?? b.textContent);
    assert({
      given: 'a leading and a trailing control',
      should: 'put the leading one first and the trailing one just before Close session',
      actual: [labels[0], labels.at(-2), labels.at(-1)],
      expected: ['Show sidebar', 'Ask', 'Close session'],
    });
  });

  test('End session is withheld from people who may not end the session', () => {
    fixtures.selection.selectedSessionId = 's2';
    const root = mount(<SessionToolbar driveId="d1" />);
    assert({
      given: 'a viewer the server does not allow to end the session',
      should: 'not offer End session',
      actual: buttonNamed(root, 'End session'),
      expected: undefined,
    });
  });

  test('Add pane asks the pane grid to open its picker for this session', () => {
    fixtures.selection.selectedSessionId = 's2';
    const before = useAgentPaneRequestStore.getState().addPane.s2 ?? 0;
    const root = mount(<SessionToolbar driveId="d1" />);
    act(() => buttonNamed(root, 'Add pane')?.click());
    assert({
      given: 'a click on Add pane',
      should: 'raise one add-pane request for the selected session',
      actual: (useAgentPaneRequestStore.getState().addPane.s2 ?? 0) - before,
      expected: 1,
    });
  });

  test('Close session drops the selection without ending anything', () => {
    fixtures.selection.selectedSessionId = 's2';
    const root = mount(<SessionToolbar driveId="d1" />);
    act(() => buttonNamed(root, 'Close session')?.click());
    assert({
      given: 'a click on Close session',
      should: 'deselect the session and DELETE nothing',
      actual: [fixtures.selection.selectSession.mock.calls, fixtures.del.mock.calls.length],
      expected: [[[null]], 0],
    });
  });

  test('falls back through the session name, the record name and "Session"', () => {
    fixtures.selection.selectedSessionId = 's2';
    fixtures.sessions = [{ ...running, envId: null, sandboxStatus: 'none' }];
    const bare = mount(<SessionToolbar driveId="d1" />);
    const noEnv = [nameOf(bare), metaOf(bare), bare.querySelector('[aria-label="Sandbox running"]')];
    unmountAll();

    fixtures.sessions = [];
    const fromRecord = nameOf(mount(<SessionToolbar driveId="d1" />));
    unmountAll();

    fixtures.record = { session: null, canEndSession: false };
    const bareLabel = nameOf(mount(<SessionToolbar />));
    assert({
      given: 'a session with no environment, then no session row, then no record',
      should: 'drop the environment and the sandbox mark, then use the record name, then plain "Session"',
      actual: [noEnv, fromRecord, bareLabel],
      expected: [['Ship status page', 'started 42 min ago', null], 'Ship status page', 'Session'],
    });
  });

  test('leaves the environment out when the session names one the drive does not have', () => {
    fixtures.selection.selectedSessionId = 's2';
    fixtures.sessions = [{ ...running, envId: 'missing' }];
    const root = mount(<SessionToolbar driveId="d1" />);
    assert({
      given: 'a session whose environment is not in the drive list',
      should: 'show the start only',
      actual: metaOf(root),
      expected: 'started 42 min ago',
    });
  });

  test("looks up environments in the record's drive, else the pane's drive", () => {
    fixtures.selection.selectedSessionId = 's2';
    fixtures.record = { session: { driveId: 'd9', name: 'x' }, canEndSession: false };
    mount(<SessionToolbar driveId="d1" />);
    const fromRecord = fixtures.envDrive;
    unmountAll();
    fixtures.record = { session: null, canEndSession: false };
    mount(<SessionToolbar />);
    assert({
      given: 'a record with its own drive, then no record and no pane drive',
      should: "ask for the record's drive first and for none when neither is known",
      actual: [fromRecord, fixtures.envDrive],
      expected: ['d9', null],
    });
  });

  test('End session asks first, then ends the session, forgets it and says so', async () => {
    fixtures.selection.selectedSessionId = 's2';
    fixtures.record = { session: { driveId: 'd1', name: 'Ship status page' }, canEndSession: true };
    fixtures.del.mockResolvedValue(undefined);
    const root = mount(<SessionToolbar driveId="d1" />);
    act(() => buttonNamed(root, 'End session')?.click());
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

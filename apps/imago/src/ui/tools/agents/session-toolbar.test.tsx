// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { useAgentPaneRequestStore } from '@/retained/stores/agent-workspace/useAgentPaneRequestStore';

const fixtures = vi.hoisted(() => ({
  selection: { selectedSessionId: null as string | null, selectedAgentId: 'a1' as string | null, selectSession: vi.fn() },
}));

vi.mock('@/retained/stores/agents/useAgentSurfaceStore', () => ({
  useAgentSurfaceStore: (select: (state: typeof fixtures.selection) => unknown) => select(fixtures.selection),
}));
vi.mock('@/retained/stores/agent-workspace/useAgentWorkspaceStore', () => ({
  useAgentWorkspaceStore: { getState: () => ({ forgetWorkspace: vi.fn() }) },
}));
vi.mock('@/retained/components/dev-preview/DevPreviewAffordance', () => ({ DevPreviewAffordance: () => null }));
vi.mock('@/retained/components/agents/EndSessionDialog', () => ({ default: () => null }));
vi.mock('@/retained/hooks/drive-envs/useDriveEnvs', () => ({
  useDriveEnvs: () => ({ envs: [{ id: 'e1', name: 'studio-web', substrate: 'sprite' }], isLoading: false, error: null, mutate: vi.fn() }),
}));
vi.mock('@/retained/components/agents/useSessionRecord', () => ({
  useSessionRecord: () => ({ data: { session: { driveId: 'd1', name: 'Ship status page' }, canEndSession: false } }),
}));
vi.mock('./agents-data', () => ({
  useAgentSessions: () => ({
    sessions: [
      {
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
      },
    ],
    isLoading: false,
    error: null,
    mutate: vi.fn(),
  }),
  useDriveAgents: () => [{ id: 'a1', title: 'Launch Agent', aiModel: 'claude-sonnet-5-5' }],
}));

const { SessionToolbar } = await import('./session-toolbar');

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
});

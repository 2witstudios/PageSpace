// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';

vi.mock('./retained-provider', () => ({ RetainedSurface: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/retained/components/agents/AgentsSurface', () => ({ default: () => <div data-surface="" /> }));
vi.mock('@/ui/tools/agents/session-toolbar', () => ({ SessionToolbar: () => <div data-toolbar="" /> }));
vi.mock('@/ui/tools/agents/account-agents-pane', () => ({ AccountAgentsPane: () => <section aria-label="Agent sessions" /> }));

const { AgentsWorkspace } = await import('./agents-workspace');

afterEach(unmountAll);

describe('AgentsWorkspace (IMC-7.29)', () => {
  test('Home leaves the session list to the shell pane', () => {
    const root = mount(<AgentsWorkspace />);
    assert({
      given: 'no drive (Home, the dashboard)',
      should: 'render the session toolbar and surface, with the every-drive pane left to the shell',
      actual: [
        root.querySelector('section[aria-label="Agent sessions"]') !== null,
        root.querySelector('[data-toolbar]') !== null,
        root.querySelector('[data-surface]') !== null,
      ],
      expected: [false, true, true],
    });
  });

  test('a drive route keeps its own Agents pane in the shell and renders no account pane', () => {
    const root = mount(<AgentsWorkspace driveId="d1" />);
    assert({
      given: 'a drive',
      should: 'leave the session list to the shell pane and render only the workspace',
      actual: root.querySelector('section[aria-label="Agent sessions"]'),
      expected: null,
    });
  });
});

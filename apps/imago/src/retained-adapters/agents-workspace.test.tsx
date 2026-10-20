// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';

vi.mock('./retained-provider', () => ({ RetainedSurface: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/retained/components/agents/AgentsSurface', () => ({ default: () => <div data-surface="" /> }));
vi.mock('@/ui/tools/agents/session-toolbar', () => ({ SessionToolbar: () => <div data-toolbar="" /> }));
vi.mock('@/retained/components/layout/left-sidebar/AgentsSidebar', () => ({ default: () => <div data-sidebar="" /> }));

const { AgentsWorkspace } = await import('./agents-workspace');

afterEach(unmountAll);

describe('AgentsWorkspace (IMC-7.29)', () => {
  test("the account route carries classic's Agents sidebar beside the session workspace", () => {
    const root = mount(<AgentsWorkspace />);
    assert({
      given: 'no drive (the account route)',
      should: 'render the sidebar, the session bar and the pane surface',
      actual: [
        root.querySelector('aside[aria-label="Agent sessions"] [data-sidebar]') !== null,
        root.querySelector('[data-toolbar]') !== null,
        root.querySelector('[data-surface]') !== null,
      ],
      expected: [true, true, true],
    });
  });

  test('a drive route leaves the session list and the session bar to the shell', () => {
    const root = mount(<AgentsWorkspace driveId="d1" />);
    assert({
      given: 'a drive',
      should: 'render only the pane surface',
      actual: [root.querySelector('[data-sidebar]'), root.querySelector('[data-toolbar]'), root.querySelector('[data-surface]') !== null],
      expected: [null, null, true],
    });
  });
});

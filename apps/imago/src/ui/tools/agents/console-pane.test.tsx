// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';

vi.mock('@/retained-adapters/retained-provider', () => ({
  RetainedSurface: ({ children }: { children: ReactNode }) => <div data-retained="">{children}</div>,
}));
vi.mock('@/retained/components/layout/left-sidebar/AgentsSidebar', () => ({ default: () => <div data-agents-sidebar="" /> }));

const { ConsolePane } = await import('./console-pane');
const { useAgentSurfaceStore } = await import('@/retained/stores/agents/useAgentSurfaceStore');

afterEach(unmountAll);

describe('ConsolePane', () => {
  test("is classic's Agents sidebar under the Console head", () => {
    const root = mount(<ConsolePane driveId="d1" close={<button type="button">Close sidebar</button>} />);
    const pane = root.querySelector('section[aria-label="Console: sessions"]');
    assert({
      given: 'the Console tool on a drive',
      should: 'title the pane Console, keep Close sidebar in its head and mount the retained sidebar',
      actual: [
        pane?.querySelector('header')?.textContent,
        pane?.querySelector('[data-retained] [data-agents-sidebar]') !== null,
      ],
      expected: ['ConsoleClose sidebar', true],
    });
  });

  test('sets the session store’s drive scope itself, every drive on Home', () => {
    mount(<ConsolePane driveId="d1" close={null} />);
    const drive = useAgentSurfaceStore.getState().driveId;
    unmountAll();
    mount(<ConsolePane driveId="home" close={null} allDrives />);
    assert({
      given: 'a drive’s Console pane, then Home’s, with no route surface mounted (a phone)',
      should: 'scope picks to that drive, then to every drive',
      actual: [drive, useAgentSurfaceStore.getState().driveId],
      expected: ['d1', null],
    });
  });
});

// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';

const viewport = vi.hoisted(() => ({ phone: false }));
vi.mock('@/ui/frame/viewport/use-viewport-tier', () => ({ usePhone: () => viewport.phone }));
vi.mock('@/ui/frame/drives/home-drive-context', () => ({ useHomeDriveId: () => 'home' }));
vi.mock('./retained-provider', () => ({ RetainedSurface: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/retained/components/agents/AgentsSurface', () => ({ default: () => <div data-surface="" /> }));
vi.mock('@/ui/tools/agents/session-toolbar', () => ({ SessionToolbar: () => <div data-toolbar="" /> }));
vi.mock('@/ui/tools/agents/home-console-pane', () => ({ HomeConsolePane: () => <section aria-label="Console: agents and sessions" /> }));

const { AgentsWorkspace } = await import('./agents-workspace');

afterEach(() => {
  unmountAll();
  viewport.phone = false;
});

describe('AgentsWorkspace (IMC-7.29)', () => {
  test('Home leaves the session list to the shell pane', () => {
    const root = mount(<AgentsWorkspace />);
    assert({
      given: 'no drive (Home, the dashboard)',
      should: 'render the session toolbar and surface, with the every-drive pane left to the shell',
      actual: [
        root.querySelector('section[aria-label="Console: agents and sessions"]') !== null,
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
      actual: root.querySelector('section[aria-label="Console: agents and sessions"]'),
      expected: null,
    });
  });

  test('Home on a phone carries the every-drive pane itself', () => {
    viewport.phone = true;
    const root = mount(<AgentsWorkspace />);
    assert({
      given: 'Home on a phone, where the shell shows no tool pane',
      should: 'render the every-drive session list beside the surface',
      actual: root.querySelector('section[aria-label="Console: agents and sessions"]') !== null,
      expected: true,
    });
  });
});

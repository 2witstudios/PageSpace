// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';

vi.mock('./retained-provider', () => ({ RetainedSurface: ({ children }: { children: ReactNode }) => <div data-retained="">{children}</div> }));
vi.mock('@/retained/components/agents/AgentsSurface', () => ({
  default: ({ driveId }: { driveId?: string }) => <div data-surface={driveId ?? 'all'} />,
}));

const { AgentsWorkspace } = await import('./agents-workspace');

afterEach(unmountAll);

describe('AgentsWorkspace (IMC-7.29)', () => {
  test('is the pane surface alone, leaving the session list and bar to the shell', () => {
    assert({
      given: 'a drive, then Home (no drive)',
      should: 'render only the retained pane surface, scoped to that drive or to every drive',
      actual: [
        mount(<AgentsWorkspace driveId="d1" />).innerHTML,
        mount(<AgentsWorkspace />).innerHTML,
      ],
      expected: ['<div data-retained=""><div data-surface="d1"></div></div>', '<div data-retained=""><div data-surface="all"></div></div>'],
    });
  });
});

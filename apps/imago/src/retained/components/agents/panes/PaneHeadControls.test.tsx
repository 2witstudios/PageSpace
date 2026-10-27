// @vitest-environment jsdom
import { useState } from 'react';
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { useAgentPaneRequestStore } from '@/retained/stores/agent-workspace/useAgentPaneRequestStore';
import { usePaneRequest } from './PaneHeadControls';

afterEach(unmountAll);

function Harness() {
  const [adds, setAdds] = useState(0);
  usePaneRequest('addPane', 's1', () => setAdds((n) => n + 1));
  return <output data-testid="adds">{adds}</output>;
}

describe('pane requests from the session head', () => {
  test('an add-pane request reaches the grid once, and not for another session', () => {
    const root = mount(<Harness />);
    act(() => useAgentPaneRequestStore.getState().requestAddPane('s1'));
    act(() => useAgentPaneRequestStore.getState().requestAddPane('other'));
    assert({
      given: 'requests for this and another session',
      should: 'handle only this session, once',
      actual: root.querySelector('[data-testid="adds"]')?.textContent,
      expected: '1',
    });
  });

  test('a request made before the grid mounted is not replayed', () => {
    act(() => useAgentPaneRequestStore.getState().requestAddPane('s1'));
    const root = mount(<Harness />);
    assert({
      given: 'a request that landed while no grid was listening',
      should: 'not fire on mount',
      actual: root.querySelector('[data-testid="adds"]')?.textContent,
      expected: '0',
    });
  });
});

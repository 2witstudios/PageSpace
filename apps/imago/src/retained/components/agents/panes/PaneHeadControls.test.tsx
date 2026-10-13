// @vitest-environment jsdom
import { useState } from 'react';
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { useAgentPaneRequestStore } from '@/retained/stores/agent-workspace/useAgentPaneRequestStore';
import { PaneSplitCloseActions } from './PaneBar';
import { OpenShellButton, agentModelToolsLabel, usePaneRequest } from './PaneHeadControls';

afterEach(unmountAll);

const noop = () => undefined;

// Mirrors AgentPanes: the shell pane's close removes the shell, the chat head then shows
// Open shell, which raises the request the grid answers by re-adding a shell pane.
function Harness() {
  const [shell, setShell] = useState(true);
  const [adds, setAdds] = useState(0);
  usePaneRequest('openShell', 's1', () => setShell(true));
  usePaneRequest('addPane', 's1', () => setAdds((n) => n + 1));
  return (
    <div>
      <output data-testid="adds">{adds}</output>
      <section aria-label="Launch Agent chat">
        <PaneSplitCloseActions canSplit={false} canClose onSplitRight={noop} onSplitDown={noop} onClose={noop} closeLabel="Close agent chat" />
        {shell ? null : <OpenShellButton onOpen={() => useAgentPaneRequestStore.getState().requestOpenShell('s1')} />}
      </section>
      {shell ? (
        <section aria-label="Shell">
          <PaneSplitCloseActions canSplit={false} canClose onSplitRight={noop} onSplitDown={noop} onClose={() => setShell(false)} closeLabel="Close shell" />
        </section>
      ) : null}
    </div>
  );
}

const byLabel = (root: HTMLElement, label: string) => root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const byText = (root: HTMLElement, text: string) =>
  Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);

describe('agent pane heads (IMC-6.4)', () => {
  test('the close buttons carry the board labels', () => {
    const root = mount(<Harness />);
    assert({
      given: 'a chat pane and a shell pane',
      should: 'label their closes "Close agent chat" and "Close shell"',
      actual: [byLabel(root, 'Close agent chat') !== null, byLabel(root, 'Close shell') !== null],
      expected: [true, true],
    });
  });

  test('Close shell hides the shell, Open shell appears and restores one', () => {
    const root = mount(<Harness />);
    act(() => byLabel(root, 'Close shell')?.click());
    const hidden = [byLabel(root, 'Shell') === null, byText(root, 'Open shell') !== undefined];
    act(() => byText(root, 'Open shell')?.click());
    assert({
      given: 'Close shell then Open shell',
      should: 'hide the shell with Open shell offered, then request and show a shell again',
      actual: [hidden, byLabel(root, 'Shell') !== null, byText(root, 'Open shell')],
      expected: [[true, true], true, undefined],
    });
  });

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

  test('the model and tool count read from the agent config, omitted until it loads', () => {
    assert({
      given: 'a loaded config and a missing one',
      should: 'label "<model> · <n> tools", else null',
      actual: [
        agentModelToolsLabel({ aiModel: 'claude-sonnet-5-5', enabledTools: ['a', 'b'] }),
        agentModelToolsLabel(null),
      ],
      expected: ['claude-sonnet-5-5 · 2 tools', null],
    });
  });
});

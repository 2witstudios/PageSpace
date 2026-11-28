// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import { Checkbox } from './checkbox';

afterEach(unmountAll);

function Harness() {
  const [checked, setChecked] = useState(false);
  return <Checkbox checked={checked} label="Mark done" toggle={() => setChecked((now) => !now)} />;
}

describe('Checkbox', () => {
  test('focus and toggling', () => {
    const container = mount(<Harness />);
    const box = container.querySelector<HTMLButtonElement>('[role="checkbox"]');
    box?.focus();
    const focused = document.activeElement === box;
    const states = [box?.getAttribute('aria-checked')];
    if (box) click(box);
    states.push(box?.getAttribute('aria-checked'));
    if (box) click(box);
    states.push(box?.getAttribute('aria-checked'));
    assert({
      given: 'a mounted checkbox focused from the keyboard and activated twice',
      should: 'take focus and report each new state',
      actual: { focused, states, name: box?.getAttribute('aria-label') },
      expected: { focused: true, states: ['false', 'true', 'false'], name: 'Mark done' },
    });
  });
});

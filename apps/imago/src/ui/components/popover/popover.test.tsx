// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, press, unmountAll } from '../../test-support/dom';
import { ChoiceMenu } from './menu';
import { Popover } from './popover';

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(unmountAll);

const dialog = (name: string) => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${name}"]`);

describe('Popover', () => {
  test('opening, closing from inside, and Escape', () => {
    const container = mount(
      <Popover label="Pick" trigger={<button type="button">Open</button>}>
        {(close) => (
          <button type="button" onClick={close}>
            Close me
          </button>
        )}
      </Popover>,
    );
    const trigger = container.querySelector('button') as HTMLButtonElement;
    const closed = dialog('Pick');
    click(trigger);
    const open = { dialog: dialog('Pick') !== null, expanded: trigger.getAttribute('aria-expanded') };
    click([...(dialog('Pick')?.querySelectorAll('button') ?? [])][0] as HTMLButtonElement);
    const afterClose = dialog('Pick');
    click(trigger);
    press(dialog('Pick') as HTMLElement, 'Escape');
    assert({
      given: 'a popover opened from its trigger, closed from inside, opened again and escaped',
      should: 'render its content only while open, in a named dialog',
      actual: { closed, open, afterClose, escaped: dialog('Pick') },
      expected: { closed: null, open: { dialog: true, expanded: 'true' }, afterClose: null, escaped: null },
    });
  });
});

describe('ChoiceMenu', () => {
  test('choosing from the keyboard', () => {
    const chosen: string[] = [];
    const container = mount(
      <ChoiceMenu
        label="Priority"
        value="medium"
        options={[
          { value: 'high', label: 'High' },
          { value: 'medium', label: 'Medium' },
          { value: 'low', label: 'Low' },
        ]}
        choose={(value) => chosen.push(value)}
        trigger={<button type="button">Priority</button>}
      />,
    );
    const trigger = container.querySelector('button') as HTMLButtonElement;
    press(trigger, 'Enter');
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Priority"]');
    const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const state = items.map((item) => [item.textContent, item.getAttribute('aria-checked')]);
    act(() => {
      items[1]?.click();
    });
    press(trigger, 'Enter');
    act(() => {
      [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')][0]?.click();
    });
    assert({
      given: 'the menu opened with Enter, the current option chosen, then High',
      should: 'list the options with the current one checked, and report only the change',
      actual: { state, chosen, closed: document.querySelector('[role="menu"]') },
      expected: {
        state: [
          ['High', 'false'],
          ['Medium', 'true'],
          ['Low', 'false'],
        ],
        chosen: ['high'],
        closed: null,
      },
    });
  });
});

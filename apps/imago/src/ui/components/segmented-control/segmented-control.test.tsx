// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { SegmentedControl } from './segmented-control';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { root: Root; container: HTMLElement }[] = [];

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted = [];
});

// Attached to the document, so focus() moves document.activeElement.
const mount = (tree: ReactNode): HTMLElement => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(tree));
  return container;
};

/** Presses a key on whatever has focus; returns whether the default was prevented. */
const press = (key: string): boolean => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    document.activeElement?.dispatchEvent(event);
  });
  return event.defaultPrevented;
};

type View = 'focus' | 'tree' | 'board';

function Harness({ selections }: { readonly selections: View[] }) {
  const [value, setValue] = useState<View>('tree');
  return (
    <SegmentedControl
      label="View"
      segments={[
        { value: 'focus', label: 'Focus' },
        { value: 'tree', label: 'Tree' },
        { value: 'board', label: 'Board', count: 4 },
      ]}
      value={value}
      select={(next) => {
        selections.push(next);
        setValue(next);
      }}
    />
  );
}

/** The checked radio's name and whether it holds focus and the group's only tab stop. */
const state = (container: HTMLElement) => {
  const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const checked = radios.filter((radio) => radio.getAttribute('aria-checked') === 'true');
  return {
    checked: checked.map((radio) => radio.textContent),
    focused: document.activeElement === checked[0],
    tabStops: radios.filter((radio) => radio.tabIndex === 0).map((radio) => radio.textContent),
  };
};

describe('SegmentedControl', () => {
  test('a radiogroup reached by one tab stop', () => {
    const container = mount(<Harness selections={[]} />);
    const group = container.querySelector('[role="radiogroup"]');
    assert({
      given: 'a mounted control with Tree chosen',
      should: 'expose a named radiogroup of three radios with Tree the only tab stop',
      actual: {
        name: group?.getAttribute('aria-label'),
        radios: group?.querySelectorAll('[role="radio"]').length,
        tabStops: state(container).tabStops,
      },
      expected: { name: 'View', radios: 3, tabStops: ['Tree'] },
    });
  });

  test('arrow keys move focus and selection together, wrapping', () => {
    const selections: View[] = [];
    const container = mount(<Harness selections={selections} />);
    act(() => container.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
    const steps = ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowUp'].map(
      (key) => ({ key, prevented: press(key), ...state(container) }),
    );
    assert({
      given: 'Tree focused, then Right, Right, Down, Left, Up, Up',
      should: 'check and focus each next radio, wrap at both ends and keep one tab stop',
      actual: { steps, selections },
      expected: {
        steps: [
          { key: 'ArrowRight', prevented: true, checked: ['Board · 4'], focused: true, tabStops: ['Board · 4'] },
          { key: 'ArrowRight', prevented: true, checked: ['Focus'], focused: true, tabStops: ['Focus'] },
          { key: 'ArrowDown', prevented: true, checked: ['Tree'], focused: true, tabStops: ['Tree'] },
          { key: 'ArrowLeft', prevented: true, checked: ['Focus'], focused: true, tabStops: ['Focus'] },
          { key: 'ArrowUp', prevented: true, checked: ['Board · 4'], focused: true, tabStops: ['Board · 4'] },
          { key: 'ArrowUp', prevented: true, checked: ['Tree'], focused: true, tabStops: ['Tree'] },
        ],
        selections: ['board', 'focus', 'tree', 'focus', 'board', 'tree'],
      },
    });
  });

  test('Home and End', () => {
    const selections: View[] = [];
    const container = mount(<Harness selections={selections} />);
    act(() => container.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
    press('Home');
    const home = state(container);
    press('End');
    assert({
      given: 'Home, then End',
      should: 'check and focus the first radio, then the last',
      actual: { home, end: state(container), selections },
      expected: {
        home: { checked: ['Focus'], focused: true, tabStops: ['Focus'] },
        end: { checked: ['Board · 4'], focused: true, tabStops: ['Board · 4'] },
        selections: ['focus', 'board'],
      },
    });
  });

  test('keys it does not own', () => {
    const selections: View[] = [];
    const container = mount(<Harness selections={selections} />);
    act(() => container.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
    const prevented = ['Tab', 'a', 'Enter'].map(press);
    assert({
      given: 'Tab, a letter and Enter on the checked radio',
      should: 'leave the selection, focus and default behaviour alone',
      actual: { prevented, selections, ...state(container) },
      expected: {
        prevented: [false, false, false],
        selections: [],
        checked: ['Tree'],
        focused: true,
        tabStops: ['Tree'],
      },
    });
  });

  test('pointer selection', () => {
    const selections: View[] = [];
    const container = mount(<Harness selections={selections} />);
    const board = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')][2];
    act(() => board?.click());
    assert({
      given: 'a click on Board',
      should: 'select it once and make it the tab stop',
      actual: { selections, checked: state(container).checked, tabStops: state(container).tabStops },
      expected: { selections: ['board'], checked: ['Board · 4'], tabStops: ['Board · 4'] },
    });
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import type { DriveSummary } from '../drives/drives';
import { stageFor } from '../stage/stage';
import { BrandChip } from './brand-chip';

const drives: DriveSummary[] = [
  { id: 'home-1', name: 'Home', kind: 'HOME' },
  { id: 'd-alpha', name: 'Alpha', kind: 'STANDARD' },
];

/** The browser flips `open` at once but fires `toggle` as a later task; only that reaches React. */
const toggle = async (details: HTMLDetailsElement): Promise<void> => {
  const toggled = new Promise<void>((resolve) => details.addEventListener('toggle', () => resolve(), { once: true }));
  act(() => details.querySelector('summary')?.click());
  await act(() => toggled);
};

afterEach(() => {
  unmountAll();
});

describe('BrandChip', () => {
  test('switching drive keeps the section', async () => {
    const container = mount(
      <BrandChip stage={stageFor('/d-alpha/messages/channel-1')} currentId="d-alpha" drives={drives} failed={false} />,
    );
    const details = container.querySelector('details');
    if (details === null) throw new Error('no switcher');
    await toggle(details);
    const opened = details.open;
    const home = container.querySelector<HTMLAnchorElement>('a[href="/home-1/messages"]');
    // jsdom has no app router: stop Next's Link at the anchor; the chip's onClick runs first.
    const navigated = vi.fn((event: Event) => event.preventDefault());
    home?.addEventListener('click', navigated);
    act(() => home?.click());

    assert({
      given: 'a channel open in Alpha, the switcher opened and Home picked',
      should: 'follow Home’s Messages link and close the menu',
      actual: [opened, navigated.mock.calls.length, details.open],
      expected: [true, 1, false],
    });
  });

  test('closing like a menu', async () => {
    const container = mount(<BrandChip stage={stageFor('/d-alpha')} currentId="d-alpha" drives={drives} failed={false} />);
    const details = container.querySelector('details');
    if (details === null) throw new Error('no switcher');
    await toggle(details);
    act(() => {
      details.querySelector('a')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    const afterEscape = details.open;
    const focusBack = document.activeElement === details.querySelector('summary');
    await toggle(details);
    act(() => {
      details.querySelector('ul')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    const insidePress = details.open;
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    assert({
      given: 'Escape, then a press inside the menu, then a press outside',
      should: 'close on Escape with focus on the chip, stay open for the inside press and close for the outside one',
      actual: [afterEscape, focusBack, insidePress, details.open],
      expected: [false, true, true, false],
    });
  });
});

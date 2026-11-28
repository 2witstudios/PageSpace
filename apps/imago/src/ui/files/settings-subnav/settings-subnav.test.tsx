// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { SettingsSubnav, type SettingsSubnavItem } from './settings-subnav';
import { useSettingsSubnavStore } from './settings-subnav-store';

type Key = 'behavior' | 'access' | 'tools';

const items: readonly SettingsSubnavItem<Key>[] = [
  { key: 'behavior', title: 'Behavior', description: 'Model and instructions' },
  { key: 'access', title: 'Access', description: 'Drive membership' },
  { key: 'tools', title: 'Tools', description: 'Sandbox and default tools' },
];

const nav = (container: HTMLElement): HTMLElement | null => container.querySelector('nav[aria-label="Agent settings"]');
const rows = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(nav(container)?.querySelectorAll<HTMLButtonElement>('button:not([aria-label])') ?? []);
const button = (container: HTMLElement, label: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

const render = (selected: Key = 'behavior', onSelect = vi.fn()) =>
  mount(
    <SettingsSubnav<Key> navLabel="Agent settings" heading="Settings" items={items} selected={selected} onSelect={onSelect}>
      <div data-testid="form">Behavior form</div>
    </SettingsSubnav>,
  );

beforeEach(() => {
  useSettingsSubnavStore.setState({ open: true });
});

afterEach(unmountAll);

describe('SettingsSubnav', () => {
  test('renders a persistent nav named by the caller with one row per category', () => {
    const container = render();
    assert({
      given: 'a settings area with three categories',
      should: 'render a nav with the given aria-label listing the rows in order',
      actual: rows(container).map((row) => row.textContent),
      expected: ['BehaviorModel and instructions', 'AccessDrive membership', 'ToolsSandbox and default tools'],
    });
  });

  test('marks only the selected row with aria-current', () => {
    const container = render('access');
    assert({
      given: 'the Access category selected',
      should: 'put aria-current="page" on the Access row alone',
      actual: rows(container).map((row) => row.getAttribute('aria-current')),
      expected: [null, 'page', null],
    });
  });

  test('passes a row click to onSelect with its key', () => {
    const onSelect = vi.fn();
    const container = render('behavior', onSelect);
    const tools = rows(container)[2];
    if (tools) click(tools);
    assert({
      given: 'a click on the Tools row',
      should: 'report the tools key to the host',
      actual: onSelect.mock.calls,
      expected: [['tools']],
    });
  });

  test('draws the selected category form to the right of the nav', () => {
    const container = render();
    assert({
      given: 'a settings area with a form child',
      should: 'render the form beside the nav, not inside it',
      actual: { inNav: nav(container)?.querySelector('[data-testid="form"]') ?? null, rendered: container.querySelector('[data-testid="form"]') !== null },
      expected: { inNav: null, rendered: true },
    });
  });

  test('collapses to a Show settings menu button when Close settings menu is pressed', () => {
    const container = render();
    const close = button(container, 'Close settings menu');
    if (close) click(close);
    assert({
      given: 'the nav open and Close settings menu pressed',
      should: 'remove the nav and offer a Show settings menu button in the area head',
      actual: { nav: nav(container), show: button(container, 'Show settings menu') !== null, store: useSettingsSubnavStore.getState().open },
      expected: { nav: null, show: true, store: false },
    });
  });

  test('keeps the form on screen while collapsed', () => {
    useSettingsSubnavStore.setState({ open: false });
    const container = render();
    assert({
      given: 'a collapsed sub-nav',
      should: 'keep the selected form rendered and the heading in the area head',
      actual: {
        form: container.querySelector('[data-testid="form"]') !== null,
        heading: container.textContent?.includes('Settings') ?? false,
      },
      expected: { form: true, heading: true },
    });
  });

  test('reopens from Show settings menu', () => {
    useSettingsSubnavStore.setState({ open: false });
    const container = render();
    const show = button(container, 'Show settings menu');
    if (show) click(show);
    assert({
      given: 'a collapsed sub-nav and Show settings menu pressed',
      should: 'reopen the nav and return to the Close settings menu control',
      actual: { nav: nav(container) !== null, close: button(container, 'Close settings menu') !== null, store: useSettingsSubnavStore.getState().open },
      expected: { nav: true, close: true, store: true },
    });
  });
});

describe('useSettingsSubnavStore', () => {
  test('starts open', () => {
    useSettingsSubnavStore.setState({ open: true });
    assert({
      given: 'the store on its own',
      should: 'default to an open nav, as the board shows',
      actual: useSettingsSubnavStore.getInitialState().open,
      expected: true,
    });
  });
});

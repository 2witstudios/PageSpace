// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { useSettingsSubnavStore } from '@/ui/files/settings-subnav/settings-subnav-store';
import { CanvasSettingsPanel } from './CanvasSettingsPanel';

const navigation = vi.hoisted(() => ({ category: null as string | null, replace: vi.fn() }));

vi.mock('@/retained-adapters/navigation', () => ({
  usePathname: () => '/d1/files/p1',
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.category === null ? 'tab=settings' : `tab=settings&category=${navigation.category}`),
}));

vi.mock('./CanvasPublishSettingsSection', () => ({
  CanvasPublishSettingsSection: () => <div data-testid="section">Publish section</div>,
}));
vi.mock('./CanvasAppearanceSettingsSection', () => ({
  CanvasAppearanceSettingsSection: () => <div data-testid="section">Appearance section</div>,
}));
vi.mock('./CanvasHomePageSettingsSection', () => ({
  CanvasHomePageSettingsSection: () => <div data-testid="section">Home section</div>,
}));
vi.mock('./CanvasFormsSettingsSection', () => ({
  default: () => <div data-testid="section">Forms section</div>,
}));

const nav = (container: HTMLElement) => container.querySelector('nav[aria-label="Canvas settings"]');
const rows = (container: HTMLElement) =>
  Array.from(nav(container)?.querySelectorAll<HTMLButtonElement>('button:not([aria-label])') ?? []);

beforeEach(() => {
  navigation.category = null;
  navigation.replace.mockClear();
  useSettingsSubnavStore.setState({ open: true });
});

afterEach(unmountAll);

describe('CanvasSettingsPanel', () => {
  test('renders the Canvas settings sub-nav with the four categories', () => {
    const container = mount(<CanvasSettingsPanel pageId="p1" content="" onContentChange={() => undefined} />);
    assert({
      given: 'the canvas Settings tab',
      should: 'list Publish, Appearance, Home & 404 page and Forms in a Canvas settings nav',
      actual: rows(container).map((row) => row.querySelector('span')?.textContent),
      expected: ['Publish', 'Appearance', 'Home & 404 page', 'Forms'],
    });
  });

  test('shows Publish, selected, when the URL names no category', () => {
    const container = mount(<CanvasSettingsPanel pageId="p1" content="" onContentChange={() => undefined} />);
    assert({
      given: 'no ?category= in the URL',
      should: 'mark Publish current and render its section',
      actual: {
        current: rows(container).map((row) => row.getAttribute('aria-current')),
        section: container.querySelector('[data-testid="section"]')?.textContent,
      },
      expected: { current: ['page', null, null, null], section: 'Publish section' },
    });
  });

  test('renders the category named in the URL', () => {
    navigation.category = 'forms';
    const container = mount(<CanvasSettingsPanel pageId="p1" content="" onContentChange={() => undefined} />);
    assert({
      given: 'a canvas Settings URL with category=forms',
      should: 'mark Forms current and render the Forms section',
      actual: {
        current: rows(container).map((row) => row.getAttribute('aria-current')),
        section: container.querySelector('[data-testid="section"]')?.textContent,
      },
      expected: { current: [null, null, null, 'page'], section: 'Forms section' },
    });
  });

  test('writes the chosen category into the URL', () => {
    const container = mount(<CanvasSettingsPanel pageId="p1" content="" onContentChange={() => undefined} />);
    const appearance = rows(container)[1];
    if (appearance) click(appearance);
    assert({
      given: 'a click on the Appearance row',
      should: 'replace the URL with the tab and category=appearance',
      actual: navigation.replace.mock.calls.at(-1)?.[0],
      expected: '/d1/files/p1?tab=settings&category=appearance',
    });
  });

  test('collapses to Show settings menu and keeps the section', () => {
    const container = mount(<CanvasSettingsPanel pageId="p1" content="" onContentChange={() => undefined} />);
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close settings menu"]');
    if (close) click(close);
    assert({
      given: 'Close settings menu pressed in the canvas sub-nav',
      should: 'hide the nav, offer Show settings menu, and keep the section on screen',
      actual: {
        nav: nav(container),
        show: container.querySelector('button[aria-label="Show settings menu"]') !== null,
        section: container.querySelector('[data-testid="section"]') !== null,
      },
      expected: { nav: null, show: true, section: true },
    });
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { mount, unmountAll } from '../../test-support/dom';
import { usePublishStatusStore, EMPTY_PUBLISH_SETTINGS, type PublishStatus } from '@/retained/stores/usePublishStatusStore';
import type { TreePage } from '@/retained/hooks/usePageTree';

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ fetchWithAuth: () => new Promise(() => undefined) }));
const navigation = vi.hoisted(() => ({ tab: null as string | null, canEdit: true, replace: vi.fn() }));
vi.mock('@/retained-adapters/navigation', () => ({
  useParams: () => ({ driveId: 'd1' }),
  usePathname: () => '/d1/files/p1',
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.tab === null ? '' : `tab=${navigation.tab}`),
}));
vi.mock('@/retained/hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: { canView: true, canEdit: navigation.canEdit, canShare: false, canDelete: false } }),
}));

const { CanvasPage } = await import('./canvas-page');

const PAGE_ID = 'p1';
const page = { id: PAGE_ID, type: 'CANVAS' } as unknown as TreePage;

const publishedStatus = (overrides: Partial<PublishStatus> = {}): PublishStatus => ({
  published: true,
  canEdit: true,
  url: 'https://launch.studio.example/waitlist-page',
  available: true,
  isStale: false,
  hasLoadError: false,
  settings: EMPTY_PUBLISH_SETTINGS,
  ...overrides,
});

const seed = (status: PublishStatus | null): void => {
  usePublishStatusStore.setState({ statuses: new Map(status ? [[PAGE_ID, status]] : []) });
};

const strip = (container: HTMLElement): HTMLElement => container.querySelector('[role="toolbar"]') as HTMLElement;

beforeEach(() => {
  navigation.tab = null;
  navigation.canEdit = true;
  navigation.replace.mockClear();
  seed(publishedStatus());
});

afterEach(unmountAll);

describe('CanvasPage Page tools strip', () => {
  test('renders the strip as a Page tools toolbar holding a Canvas tablist', () => {
    const container = mount(<CanvasPage page={page} driveId="d1" pageId={PAGE_ID} />);
    const tablist = strip(container).querySelector('[role="tablist"]');
    assert({
      given: 'a canvas page',
      should: 'render the Canvas tablist inside the Page tools strip',
      actual: [strip(container).getAttribute('aria-label'), tablist?.getAttribute('aria-label')],
      expected: ['Page tools', 'Canvas'],
    });
  });

  test('lists View, Code and Settings as tabs in that order', () => {
    const container = mount(<CanvasPage page={page} driveId="d1" pageId={PAGE_ID} />);
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);
    assert({
      given: 'a canvas page',
      should: 'offer View, Code and Settings as tabs',
      actual: labels,
      expected: ['View', 'Code', 'Settings'],
    });
  });

  test('marks View as selected when no tab is in the URL', () => {
    const container = mount(<CanvasPage page={page} driveId="d1" pageId={PAGE_ID} />);
    const selected = Array.from(container.querySelectorAll('[role="tab"]'))
      .filter((tab) => tab.getAttribute('aria-selected') === 'true')
      .map((tab) => tab.textContent);
    assert({
      given: 'a canvas page with no ?tab= in the URL',
      should: 'select the View tab',
      actual: selected,
      expected: ['View'],
    });
  });

  test('marks the tab named in the URL as selected', () => {
    navigation.tab = 'code';
    const container = mount(<CanvasPage page={page} driveId="d1" pageId={PAGE_ID} />);
    const selected = Array.from(container.querySelectorAll('[role="tab"]'))
      .filter((tab) => tab.getAttribute('aria-selected') === 'true')
      .map((tab) => tab.textContent);
    assert({
      given: 'a canvas page opened on ?tab=code',
      should: 'select the Code tab',
      actual: selected,
      expected: ['Code'],
    });
  });

  test('shows the stale chip "Published · changes not live" with the Update action at the end', () => {
    seed(publishedStatus({ isStale: true }));
    const container = mount(<CanvasPage page={page} driveId="d1" pageId={PAGE_ID} />);
    const text = strip(container).textContent ?? '';
    const buttons = Array.from(strip(container).querySelectorAll('button')).map((button) => button.textContent);
    assert({
      given: 'a published canvas whose content has changed since publish',
      should: 'show the status chip "Published · changes not live"',
      actual: text.includes('Published · changes not live'),
      expected: true,
    });
    assert({
      given: 'a published canvas whose content has changed since publish',
      should: 'offer the Republish action as the last control in the strip',
      actual: buttons.at(-1),
      expected: 'Republish',
    });
  });

  test('shows only the Published chip when the published copy is current', () => {
    const container = mount(<CanvasPage page={page} driveId="d1" pageId={PAGE_ID} />);
    const buttons = Array.from(strip(container).querySelectorAll('button')).map((button) => button.textContent);
    assert({
      given: 'a published canvas with no unpublished changes',
      should: 'show "Published" and no Republish action',
      actual: [strip(container).textContent?.includes('Published'), buttons.includes('Republish')],
      expected: [true, false],
    });
  });

  test('disables the Settings tab for a view-only viewer', () => {
    navigation.canEdit = false;
    const container = mount(<CanvasPage page={page} driveId="d1" pageId={PAGE_ID} />);
    const settings = Array.from(container.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === 'Settings');
    assert({
      given: 'a view-only viewer of a canvas',
      should: 'disable the Settings tab',
      actual: (settings as HTMLButtonElement | undefined)?.disabled,
      expected: true,
    });
  });

  test('switches tabs through the URL when a tab is clicked', async () => {
    const container = mount(<CanvasPage page={page} driveId="d1" pageId={PAGE_ID} />);
    const code = Array.from(container.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === 'Code') as HTMLButtonElement;
    await act(async () => {
      code.click();
    });
    assert({
      given: 'the Code tab is clicked',
      should: 'write ?tab=code to the URL',
      actual: navigation.replace.mock.calls.at(-1)?.[0],
      expected: '/d1/files/p1?tab=code',
    });
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll, click } from '../../test-support/dom';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { ActivityPane } from './activity-pane';

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  search: '',
  pathname: '/d1/activity/view',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

afterEach(() => {
  unmountAll();
  nav.replace.mockReset();
  nav.push.mockReset();
  nav.search = '';
  nav.pathname = '/d1/activity/view';
});

const ACTORS = 'GET /api/activities/actors?context=drive&driveId=d1';

const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet: flush again.
    }
  }
  check();
};

const show = (search = '') => {
  nav.search = search;
  const web = fakeWeb({
    [ACTORS]: () => Response.json({ actors: [{ id: 'a1', name: 'Dana', email: 'dana@example.com', image: null }] }),
  });
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <ActivityPane driveId="d1" close={null} />
    </ImagoSWRProvider>,
  );
  return { container, web };
};

const button = (container: HTMLElement, name: string): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found;
};

describe('ActivityPane', () => {
  test('is a Filters section headed Activity', async () => {
    const { container } = show();
    await settle(() => expect(container.querySelector('section[aria-label="Filters"]')).not.toBeNull());
    assert({
      given: 'the Activity pane mounted on a drive',
      should: 'render a Filters section headed "Activity"',
      actual: container.querySelector('section[aria-label="Filters"] header')?.textContent,
      expected: 'Activity',
    });
  });

  test('lists the drive actors under People & agents', async () => {
    const { container, web } = show();
    await settle(() => expect(container.querySelector('#activity-actor option[value="a1"]')).not.toBeNull());
    assert({
      given: 'the drive actors from the actors route',
      should: 'offer Everyone and each actor by name',
      actual: Array.from(container.querySelectorAll('#activity-actor option')).map((option) => option.textContent),
      expected: ['Everyone', 'Dana'],
    });
    assert({
      given: 'the pane loaded its actors',
      should: 'request them for this drive only',
      actual: web.count(ACTORS),
      expected: 1,
    });
  });

  test('marks the resource chip the URL names as pressed', async () => {
    const { container } = show('resourceType=page');
    await settle(() => expect(container.querySelector('button[aria-pressed="true"]')).not.toBeNull());
    assert({
      given: 'a resourceType=page query',
      should: 'press the page chip and no other',
      actual: Array.from(container.querySelectorAll('button[aria-pressed="true"]'))
        .filter((node) => !node.closest('[role="group"]'))
        .map((node) => node.textContent),
      expected: ['page'],
    });
  });

  test('writes a date range choice into the URL', async () => {
    const { container } = show('resourceType=page');
    await settle(() => expect(container.querySelector('[role="group"][aria-label="Date range"]')).not.toBeNull());
    click(button(container, '24h'));
    assert({
      given: 'the 24h range chosen while a resource is filtered',
      should: 'replace the URL keeping the resource and naming the range',
      actual: nav.replace.mock.calls[0]?.[0],
      expected: '/d1/activity/view?resourceType=page&range=24h',
    });
  });

  test('clears the range from the URL when the default 7 days is chosen', async () => {
    const { container } = show('range=24h');
    await settle(() => expect(button(container, '7 days')).toBeDefined());
    click(button(container, '7 days'));
    assert({
      given: '7 days chosen from a 24h view',
      should: 'drop the range key, which is the default',
      actual: nav.replace.mock.calls[0]?.[0],
      expected: '/d1/activity/view',
    });
  });

  test('toggles a resource chip off when it is pressed again', async () => {
    const { container } = show('resourceType=page');
    await settle(() => expect(button(container, 'page')).toBeDefined());
    click(button(container, 'page'));
    assert({
      given: 'the page chip already pressed',
      should: 'clear the resource filter',
      actual: nav.replace.mock.calls[0]?.[0],
      expected: '/d1/activity/view',
    });
  });

  test('a filter set from the pane alone opens the timeline', async () => {
    nav.pathname = '/d1/activity';
    const { container } = show();
    await settle(() => expect(button(container, '24h')).toBeDefined());
    click(button(container, '24h'));
    assert({
      given: 'the Activity pane beside the chat, with no timeline open, and a range chosen',
      should: 'push the timeline screen filtered to it, rather than replace the pane’s address',
      actual: [nav.push.mock.calls[0]?.[0], nav.replace.mock.calls.length],
      expected: ['/d1/activity/view?range=24h', 0],
    });
  });

  test('All activity opens the unfiltered timeline', async () => {
    const { container } = show();
    await settle(() => expect(container.querySelector('a[href="/d1/activity/view"]')).not.toBeNull());
    assert({
      given: 'the pane on the timeline with no filter',
      should: 'link All activity to the timeline screen and mark it current',
      actual: [
        container.querySelector('a[href="/d1/activity/view"]')?.textContent,
        container.querySelector('a[href="/d1/activity/view"]')?.getAttribute('aria-current'),
      ],
      expected: ['All activity', 'page'],
    });
  });
});

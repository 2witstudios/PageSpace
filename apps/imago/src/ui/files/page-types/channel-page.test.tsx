// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import type { TreePage } from '@/retained/hooks/usePageTree';
import { ChannelPage } from './channel-page';

vi.mock('next/dynamic', async () => {
  const { createElement: h } = await import('react');
  return {
    default: () => (props: { floatingWebhooks?: boolean }) =>
      h('div', { 'data-testid': 'channel-view', 'data-floating': String(props.floatingWebhooks) }),
  };
});

vi.mock('@/retained/components/shared/PageWebhooksDialog', async () => {
  const { createElement: h } = await import('react');
  return {
    PageWebhooksDialog: (props: { open: boolean; pageId: string; pageType: string }) =>
      props.open ? h('div', { role: 'dialog', 'aria-label': 'Webhooks', 'data-page': props.pageId, 'data-type': props.pageType }) : null,
  };
});

afterEach(unmountAll);

const page = { id: 'c1', driveId: 'd1', title: 'Launch', type: 'CHANNEL' } as unknown as TreePage;

describe('ChannelPage', () => {
  test('renders the Channel tools strip', () => {
    const container = mount(createElement(ChannelPage, { page, driveId: 'd1', pageId: 'c1' }));
    assert({
      given: 'a channel page',
      should: 'render the Channel tools toolbar strip',
      actual: container.querySelector('[role="toolbar"]')?.getAttribute('aria-label'),
      expected: 'Channel tools',
    });
  });

  test('leaves the audience line and Threads count out until their APIs exist', () => {
    const container = mount(createElement(ChannelPage, { page, driveId: 'd1', pageId: 'c1' }));
    const strip = container.querySelector('[role="toolbar"]')?.textContent ?? '';
    assert({
      given: 'a channel page with no channel members or thread-count API',
      should: 'not draw the audience line or Threads · n in the strip',
      actual: /Everyone with access|Threads/.test(strip),
      expected: false,
    });
  });

  test('opens the webhooks dialog for this channel from the strip button', () => {
    const container = mount(createElement(ChannelPage, { page, driveId: 'd1', pageId: 'c1' }));
    const before = container.querySelector('[role="dialog"]');
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Webhooks"]');
    if (button) click(button);
    const dialog = document.querySelector('[role="dialog"][aria-label="Webhooks"]');
    assert({
      given: 'the Webhooks button in the strip',
      should: 'open PageWebhooksDialog for this channel only after a click',
      actual: { before: before === null, page: dialog?.getAttribute('data-page') ?? null, type: dialog?.getAttribute('data-type') ?? null },
      expected: { before: true, page: 'c1', type: 'CHANNEL' },
    });
  });

  test('turns off the classic floating webhooks button so there is one entry point', () => {
    const container = mount(createElement(ChannelPage, { page, driveId: 'd1', pageId: 'c1' }));
    assert({
      given: 'the channel view inside the page module',
      should: 'pass floatingWebhooks=false to ChannelView',
      actual: container.querySelector('[data-testid="channel-view"]')?.getAttribute('data-floating'),
      expected: 'false',
    });
  });
});

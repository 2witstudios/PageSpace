// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '@/ui/test-support/find-element';
import type { Post } from '../message-model/post';
import type { PostItem } from '../post-groups/post-groups';
import { mentionClass, postClass, reactionClass } from './thread-view-class';
import { renderThreadView, type ThreadViewRenderProps } from './thread-view.render';

const post = (id: string, overrides: Partial<Post> = {}): Post => ({
  id,
  authorKey: 'u2',
  authorName: 'Grace Hopper',
  authorImage: null,
  agent: false,
  countsAsUnread: true,
  at: '2026-10-05T09:12:00.000Z',
  text: `post ${id}`,
  edited: false,
  reactions: [],
  ...overrides,
});

const props = (overrides: Partial<ThreadViewRenderProps> = {}): ThreadViewRenderProps => ({
  name: 'launch',
  viewerId: 'u1',
  status: 'ready',
  items: [],
  older: 'none',
  loadOlder: () => {},
  composer: { draft: '', error: null, typeDraft: () => {}, send: () => {} },
  ...overrides,
});

/** The markup in a detached container, to query like the browser would. */
const dom = (overrides: Partial<ThreadViewRenderProps> = {}): HTMLElement => {
  const container = document.createElement('div');
  container.innerHTML = renderToString(renderThreadView(props(overrides)));
  return container;
};

const text = (element: Element | null | undefined): string | null => element?.textContent ?? null;

describe('renderThreadView()', () => {
  test('the channel', () => {
    const view = dom();
    assert({
      given: 'a channel named launch',
      should: 'label the thread and title it with a hash',
      actual: [view.querySelector('section')?.getAttribute('aria-label'), text(view.querySelector('h1'))],
      expected: ['# launch', 'launch'],
    });
  });

  test('flat grouped posts', () => {
    const items: PostItem[] = [
      { kind: 'post', id: 'a', post: post('a', { authorImage: 'https://img/grace.png' }), lead: true },
      { kind: 'post', id: 'b', post: post('b', { at: '2026-10-05T09:14:00.000Z', edited: true }), lead: false },
    ];
    const view = dom({ items });
    const [lead, follow] = [...view.querySelectorAll('ol > li')];
    assert({
      given: 'a lead post and a follow-up in its group',
      should: 'give the lead the face, name and UTC time, and the follow-up only its body with a hover time and a spoken author',
      actual: [
        [lead?.querySelector('img')?.getAttribute('src'), text(lead?.querySelector('b')), text(lead?.querySelector('time')), lead?.className === postClass({ lead: true, mentioned: false })],
        [follow?.querySelector('img'), follow?.querySelector('b'), text(follow?.querySelector('time')), text(follow?.querySelector('.sr-only')), follow?.className === postClass({ lead: false, mentioned: false })],
        text(follow?.querySelector('[data-edited]')),
      ],
      expected: [
        ['https://img/grace.png', 'Grace Hopper', '9:12 AM', true],
        [null, null, '9:14', 'Grace Hopper said: ', true],
        '(edited)',
      ],
    });
  });

  test('post text is never markup', () => {
    const view = dom({
      items: [{ kind: 'post', id: 'a', post: post('a', { text: '<img src=x onerror=alert(1)>**bold**' }), lead: true }],
    });
    assert({
      given: 'a post whose text holds HTML',
      should: 'show it as text and create no element from it',
      actual: [view.querySelectorAll('ol img').length, text(view.querySelector('ol p:last-of-type'))],
      expected: [0, '<img src=x onerror=alert(1)>**bold**'],
    });
  });

  test('mentions, read-only', () => {
    const view = dom({
      items: [
        {
          kind: 'post',
          id: 'a',
          post: post('a', { text: 'ping @[Ada Lovelace](u1:user) and @[Roadmap](p9:page)' }),
          lead: true,
        },
      ],
    });
    const row = view.querySelector('ol > li');
    const mentions = [...(row?.querySelectorAll('[data-mention]') ?? [])];
    assert({
      given: 'a post mentioning the viewer and a page, in the stored @[label](id:type) format',
      should: 'show each as a non-interactive @label, the viewer’s marked as theirs, and fill the row as a mention of the viewer',
      actual: [
        mentions.map((mention) => [mention.tagName, text(mention), mention.getAttribute('data-mention'), mention.className]),
        row?.querySelectorAll('a, button').length,
        row?.className,
      ],
      expected: [
        [
          ['SPAN', '@Ada Lovelace', 'user', mentionClass(true)],
          ['SPAN', '@Roadmap', 'page', mentionClass(false)],
        ],
        0,
        postClass({ lead: true, mentioned: true }),
      ],
    });
  });

  test('reactions, read-only', () => {
    const view = dom({
      items: [
        {
          kind: 'post',
          id: 'a',
          post: post('a', {
            reactions: [
              { emoji: '👍', count: 2, names: ['Grace Hopper', 'Ada Lovelace'], mine: true },
              { emoji: '🎉', count: 1, names: ['Grace Hopper'], mine: false },
            ],
          }),
          lead: true,
        },
      ],
    });
    const list = view.querySelector('ul[aria-label="Reactions"]');
    assert({
      given: 'two reactions, one including the viewer',
      should: 'list each emoji with its count and who reacted, the viewer’s marked, with nothing to press',
      actual: [
        [...(list?.querySelectorAll('li') ?? [])].map((chip) => [
          chip.getAttribute('aria-label'),
          chip.getAttribute('title'),
          text(chip),
          chip.className,
        ]),
        list?.querySelectorAll('button, a').length,
      ],
      expected: [
        [
          ['👍 2, including you', 'Grace Hopper, Ada Lovelace', '👍2', reactionClass(true)],
          ['🎉 1', 'Grace Hopper', '🎉1', reactionClass(false)],
        ],
        0,
      ],
    });
  });

  test('day and New dividers', () => {
    const view = dom({
      items: [
        { kind: 'day', id: 'day-a', label: 'Yesterday', unread: false },
        { kind: 'post', id: 'a', post: post('a'), lead: true },
        { kind: 'new', id: 'new' },
        { kind: 'post', id: 'b', post: post('b'), lead: true },
        { kind: 'day', id: 'day-c', label: 'Today', unread: true },
        { kind: 'post', id: 'c', post: post('c'), lead: true },
      ],
    });
    assert({
      given: 'a day divider, a New divider and a day that starts the unread',
      should: 'draw each as a labelled separator, New on the unread ones',
      actual: [...view.querySelectorAll('[role="separator"]')].map((divider) => [
        divider.getAttribute('aria-label'),
        divider.hasAttribute('data-new'),
        text(divider),
      ]),
      expected: [
        ['Yesterday', false, 'Yesterday'],
        ['New', true, 'New'],
        ['Today, New', true, 'TodayNew'],
      ],
    });
  });

  test('agents', () => {
    const view = dom({ items: [{ kind: 'post', id: 'a', post: post('a', { agent: true, authorName: 'Planner' }), lead: true }] });
    assert({
      given: 'a post by an agent',
      should: 'name the agent and draw the agent face',
      actual: [text(view.querySelector('b')), view.querySelector('ol > li svg') !== null],
      expected: ['Planner', true],
    });
  });

  test('loading, failure and an empty channel', () => {
    assert({
      given: 'the thread loading, failing and loaded with no posts',
      should: 'say so in a note, as a status or an alert',
      actual: (['loading', 'error', 'ready'] as const).map((status) => {
        const note = dom({ status }).querySelector('p');
        return [note?.getAttribute('role'), text(note)];
      }),
      expected: [
        ['status', 'Loading posts…'],
        ['alert', 'Could not load this channel.'],
        [null, 'No posts in launch yet.'],
      ],
    });
  });

  test('earlier posts', () => {
    const loadOlder = vi.fn();
    const items: PostItem[] = [{ kind: 'post', id: 'a', post: post('a'), lead: true }];
    const buttons = (['idle', 'loading', 'error', 'none'] as const).map((older) => {
      const button = dom({ items, older }).querySelector('button:not([type="submit"])');
      return button === null ? null : [text(button), button.hasAttribute('disabled')];
    });
    const element = findElement<{ onClick?: () => void }>(renderThreadView(props({ items, older: 'idle', loadOlder })), (node) => node.type === 'button');
    element?.props.onClick?.();
    assert({
      given: 'older posts to load, loading, failed, and none left',
      should: 'offer to load them, disable it while loading, offer a retry, and offer nothing at the start; pressing it loads them',
      actual: [buttons, loadOlder.mock.calls.length],
      expected: [
        [
          ['Load earlier posts', false],
          ['Loading earlier posts…', true],
          ['Could not load earlier posts. Retry', false],
          null,
        ],
        1,
      ],
    });
  });
});

describe('renderThreadView() sending', () => {
  test('the composer', () => {
    const shown = (['loading', 'error', 'ready'] as const).map(
      (status) => dom({ status }).querySelector('textarea')?.getAttribute('aria-label') ?? null,
    );
    assert({
      given: 'the thread loading, failing, and loaded (with or without posts)',
      should: 'offer the composer, named for the channel, only once loaded',
      actual: shown,
      expected: [null, null, 'Message # launch'],
    });
  });

  test('a post still sending', () => {
    const items: PostItem[] = [
      { kind: 'post', id: 'a', post: post('a'), lead: true },
      { kind: 'post', id: 'temp-n1', post: post('temp-n1', { authorKey: 'u1', pending: true }), lead: true },
    ];
    const [stored, sending] = [...dom({ items }).querySelectorAll('ol > li')];
    assert({
      given: 'a stored post and the viewer’s post not yet stored',
      should: 'mark only the sending one busy and fade it',
      actual: [
        [stored?.getAttribute('aria-busy'), stored?.hasAttribute('data-pending')],
        [sending?.getAttribute('aria-busy'), sending?.hasAttribute('data-pending'), sending?.className],
      ],
      expected: [
        [null, false],
        ['true', true, postClass({ lead: true, mentioned: false, pending: true })],
      ],
    });
  });
});

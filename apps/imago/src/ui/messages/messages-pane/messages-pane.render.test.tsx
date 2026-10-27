import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { listGroupLabelClass } from '../../components/list-group/list-group-class';
import { unreadCountClass } from '../../components/unread-count/unread-count-class';
import { messageRowClass, messagesNoteClass } from './messages-pane-class';

// next/link is the seam that prefetches: here it shows what it was handed.
vi.mock('next/link', () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean; children: ReactNode }) =>
    h('a', { href, 'data-prefetch': String(prefetch), ...rest }, children),
}));

const { renderMessagesPane } = await import('./messages-pane.render');
type Props = Parameters<typeof renderMessagesPane>[0];
type Row = Extract<Props['channels'], { status: 'ready' }>['rows'][number];

const launch: Row = {
  id: 'c1',
  kind: 'channel',
  name: 'launch',
  href: '/d1/messages/c1',
  avatarUrl: null,
  unreadCount: 2,
  selected: false,
};
const general: Row = { ...launch, id: 'c2', name: 'general', href: '/d1/messages/c2', unreadCount: 0 };
const grace: Row = {
  id: 'm1',
  kind: 'dm',
  name: 'Grace Hopper',
  href: '/dm/m1',
  avatarUrl: 'https://img/grace.png',
  unreadCount: 0,
  selected: false,
};

const html = (overrides: Partial<Props> = {}): string =>
  renderToString(
    renderMessagesPane({
      channels: { status: 'ready', rows: [launch, general] },
      direct: { status: 'ready', rows: [grace] },
      ...overrides,
    }),
  );

/** The opening tag of the link to `href`. */
const linkTo = (markup: string, href: string): string => markup.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`))?.[0] ?? '';

describe('renderMessagesPane()', () => {
  test('two sections', () => {
    const markup = html();
    assert({
      given: 'channels and direct messages',
      should: 'show a Channels section, then a Direct messages section, labelled in sentence case',
      actual: [
        [...markup.matchAll(/<section aria-label="([^"]+)"><h2 class="([^"]+)">([^<]+)<\/h2>/g)].map(([, name, cls, text]) => [
          name,
          cls === listGroupLabelClass,
          text,
        ]),
        /uppercase/.test(markup),
        markup.indexOf('launch') < markup.indexOf('Grace Hopper'),
      ],
      expected: [
        [
          ['Channels', true, 'Channels'],
          ['Direct messages', true, 'Direct messages'],
        ],
        false,
        true,
      ],
    });
  });

  test('every row links to its thread, prefetched', () => {
    const markup = html();
    assert({
      given: 'a channel row and a DM row',
      should: 'link the channel to its drive messages route and the DM to its conversation, each prefetched',
      actual: ['/d1/messages/c1', '/d1/messages/c2', '/dm/m1'].map((href) => linkTo(markup, href).includes('data-prefetch="true"')),
      expected: [true, true, true],
    });
  });

  test('unread counts', () => {
    const markup = html();
    assert({
      given: 'a channel with two unread and rows with none',
      should: 'lift only that row, draw its count in the accent pill and put the count in its name',
      actual: [
        linkTo(markup, '/d1/messages/c1').includes(`class="${messageRowClass({ selected: false, unread: true })}"`),
        linkTo(markup, '/d1/messages/c1').includes('aria-label="launch, 2 unread"'),
        markup.match(new RegExp(`<span class="${unreadCountClass}" aria-hidden="true">(\\d+)</span>`, 'g'))?.length,
        markup.includes(`<span class="${unreadCountClass}" aria-hidden="true">2</span>`),
        linkTo(markup, '/d1/messages/c2').includes(`class="${messageRowClass({ selected: false, unread: false })}"`),
        linkTo(markup, '/d1/messages/c2').includes('aria-label="general"'),
      ],
      expected: [true, true, 1, true, true, true],
    });
  });

  test('a DM with unread', () => {
    const markup = html({ direct: { status: 'ready', rows: [{ ...grace, unreadCount: 3 }] } });
    assert({
      given: 'a conversation with three unread',
      should: 'count them on its row too',
      actual: [linkTo(markup, '/dm/m1').includes('aria-label="Grace Hopper, 3 unread"'), markup.includes('aria-hidden="true">3</span>')],
      expected: [true, true],
    });
  });

  test('the open thread', () => {
    const markup = html({
      channels: { status: 'ready', rows: [{ ...launch, selected: true }, general] },
    });
    assert({
      given: 'the open channel, which still has unread',
      should: 'mark it current with the soft accent tint, and not draw its count while it is being read',
      actual: [
        linkTo(markup, '/d1/messages/c1').includes('aria-current="page"'),
        linkTo(markup, '/d1/messages/c1').includes(`class="${messageRowClass({ selected: true, unread: true })}"`),
        linkTo(markup, '/d1/messages/c2').includes('aria-current'),
        markup.includes(unreadCountClass),
      ],
      expected: [true, true, false, false],
    });
  });

  test('glyphs', () => {
    const markup = html();
    assert({
      given: 'a channel and a person',
      should: 'draw the channel with the hash glyph and the person with their avatar',
      actual: [
        /<a[^>]*href="\/d1\/messages\/c1"[^>]*><svg[^>]*lucide-hash/.test(markup),
        /<a[^>]*href="\/dm\/m1"[^>]*><span[^>]*><img src="https:\/\/img\/grace.png"/.test(markup),
      ],
      expected: [true, true],
    });
  });

  test('states', () => {
    const note = (text: string, role?: string) =>
      `<p${role ? ` role="${role}"` : ''} class="${messagesNoteClass}">${text}</p>`;
    const cases: Array<[string, Partial<Props>, string]> = [
      ['channels loading', { channels: { status: 'loading' } }, note('Loading channels…', 'status')],
      ['channels failing', { channels: { status: 'error', retry: () => {} } }, note('Could not load channels.', 'alert')],
      ['no drive (a user-level DM route)', { channels: { status: 'no-drive' } }, note('Open a drive to see its channels.')],
      ['a drive with no channels', { channels: { status: 'ready', rows: [] } }, note('No channels in this drive yet.')],
      ['DMs loading', { direct: { status: 'loading' } }, note('Loading direct messages…', 'status')],
      ['DMs failing', { direct: { status: 'error', retry: () => {} } }, note('Could not load direct messages.', 'alert')],
      ['no DMs', { direct: { status: 'ready', rows: [] } }, note('No direct messages yet.')],
    ];
    assert({
      given: 'each section loading, failing, empty or without a drive',
      should: 'keep the section and its label, and say why it has no rows',
      actual: cases.map(([name, overrides]) => {
        const markup = html(overrides);
        return [name, markup.includes('aria-label="Channels"') && markup.includes('aria-label="Direct messages"')];
      }),
      expected: cases.map(([name]) => [name, true]),
    });
    assert({
      given: 'each of those states',
      should: 'show its note',
      actual: cases.map(([name, overrides]) => [name, html(overrides).includes(cases.find(([n]) => n === name)?.[2] ?? '?')]),
      expected: cases.map(([name]) => [name, true]),
    });
  });

  test('a failed section offers to ask again', () => {
    const markup = html({ channels: { status: 'error', retry: () => {} } });
    assert({
      given: 'channels that failed and DMs that loaded',
      should: 'offer Try again only in the failed section',
      actual: markup.match(/>Try again</g)?.length ?? 0,
      expected: 1,
    });
  });
});

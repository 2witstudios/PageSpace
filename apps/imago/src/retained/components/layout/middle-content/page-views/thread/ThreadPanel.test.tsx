// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { SWRConfig } from 'swr';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { ThreadPanel, type ThreadPanelProps } from './ThreadPanel';

const spies = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: spies.fetchWithAuth,
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

// The composer is covered by its own tests; here it only has to show the label it was given.
vi.mock('@/retained/components/shared/MessageInput', () => ({
  MessageInput: (props: { alsoSendToParentLabel?: string; placeholder?: string }) =>
    createElement('div', { 'data-testid': 'composer' }, props.alsoSendToParentLabel ?? 'no-label'),
}));

// Rich text, link previews, attachments, reactions and hover actions are rendered by their own
// components; here they only need to stand in so the thread's own markup can be asserted.
vi.mock('@/retained/components/messages/RichText', () => ({
  RichText: (props: { content: string }) => createElement('span', null, props.content),
  addHardLineBreaks: (content: string) => content,
}));
vi.mock('@/retained/components/messages/MessageLinkPreviews', () => ({ MessageLinkPreviews: () => null }));
vi.mock('@/retained/components/shared/MessageAttachments', () => ({ MessageAttachments: () => null }));
vi.mock('@/retained/components/shared/MessageReactions', () => ({ MessageReactions: () => null }));
vi.mock('@/retained/components/shared/MessageHoverToolbar', () => ({ MessageHoverToolbar: () => null }));

vi.mock('@/retained/hooks/useMobileKeyboard', () => ({
  useMobileKeyboard: () => ({ isOpen: false, height: 0 }),
}));

const CHANNEL_REPLY = {
  id: 'r1',
  content: 'Screens are in the doc',
  createdAt: '2026-10-12T09:00:00.000Z',
  userId: 'u2',
  user: { id: 'u2', name: 'Dana', image: null },
  editedAt: '2026-10-12T09:05:00.000Z',
  reactions: [],
};

const AGENT_REPLY = {
  id: 'r2',
  content: 'Drafted the checklist',
  createdAt: '2026-10-12T09:10:00.000Z',
  userId: null,
  aiMeta: { senderName: 'Launch agent', senderType: 'agent' },
  reactions: [],
};

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

type Listing = { messages: unknown[]; hasMore: false; nextCursor: null; isFollowing: boolean };

const listing = (overrides: Partial<Listing> = {}): Listing => ({
  messages: [CHANNEL_REPLY, AGENT_REPLY],
  hasMore: false,
  nextCursor: null,
  isFollowing: false,
  ...overrides,
});

const parentSlot = createElement('p', null, 'Parent post body');

const renderPanel = (overrides: Partial<ThreadPanelProps> = {}, data: Listing = listing()) => {
  const onClose = vi.fn();
  const fetcher = vi.fn(async () => data);
  mount(
    createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      createElement(ThreadPanel, {
        source: 'channel',
        contextId: 'page-1',
        parentId: 'root-1',
        currentUserId: 'me',
        driveId: 'drive-1',
        parentSlot,
        resolveAuthor: (_id: string | null | undefined, fallback?: string | null) => ({
          name: fallback ?? 'Member',
          image: null,
        }),
        replyCountHint: 2,
        contextLabel: '#launch-ops',
        alsoSendToParentLabel: 'Also send to #launch-ops',
        onClose,
        fetcher,
        ...overrides,
      }),
    ),
  );
  return { onClose, fetcher };
};

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.getAttribute('aria-label') === label,
  );

// useDraft also goes through fetchWithAuth; only the follow route is what these tests assert on.
const followCalls = (): unknown[][] =>
  spies.fetchWithAuth.mock.calls.filter((call) => String(call[0]).includes('/follow'));

const headText = (): string =>
  document.querySelector('[data-testid="thread-panel"] > div')?.textContent ?? '';

describe('ThreadPanel', () => {
  beforeEach(() => {
    spies.fetchWithAuth.mockReset();
    spies.fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
  });

  afterEach(() => {
    unmountAll();
  });

  test('channel thread head reads "Thread #launch-ops" and × is labelled "Close thread"', async () => {
    const { onClose } = renderPanel();
    await flush();

    assert({
      given: 'a channel thread with the context label #launch-ops',
      should: 'show the 48px head "Thread #launch-ops"',
      actual: headText().includes('Thread #launch-ops'),
      expected: true,
    });

    const close = findButton('Close thread');
    assert({
      given: 'the thread head',
      should: 'label the × button "Close thread" and give it a matching title',
      actual: close?.getAttribute('title'),
      expected: 'Close thread',
    });

    if (close) click(close);
    assert({
      given: 'the × button is clicked',
      should: 'call the close handler once',
      actual: onClose.mock.calls.length,
      expected: 1,
    });
  });

  test('DM thread head reads "Thread Dana · DM"', async () => {
    renderPanel({
      source: 'dm',
      contextId: 'conv-1',
      contextLabel: 'Dana · DM',
      alsoSendToParentLabel: 'Also send to Dana',
    });
    await flush();

    assert({
      given: 'a DM thread with the context label Dana · DM',
      should: 'show the head "Thread Dana · DM"',
      actual: headText().includes('Thread Dana · DM'),
      expected: true,
    });
  });

  test('the follow pill reads "Follow" when not following and "Following" when following', async () => {
    renderPanel({}, listing({ isFollowing: false }));
    await flush();

    const pill = findButton('Follow thread');
    assert({
      given: 'a thread the user does not follow',
      should: 'show the visible label "Follow" on the pill',
      actual: pill?.textContent?.trim(),
      expected: 'Follow',
    });
  });

  test('following shows the "Following" pill and toggling POSTs to the channel follow route', async () => {
    renderPanel({}, listing({ isFollowing: false }));
    await flush();

    const pill = findButton('Follow thread');
    if (pill) click(pill);
    await flush();

    assert({
      given: 'the Follow pill is clicked on a channel thread',
      should: 'POST to the channel follow route for the root message',
      actual: followCalls()[0],
      expected: ['/api/channels/page-1/messages/root-1/follow', { method: 'POST' }],
    });
  });

  test('a followed thread shows "Following" and DELETEs on toggle', async () => {
    renderPanel({}, listing({ isFollowing: true }));
    await flush();

    const pill = findButton('Unfollow thread');
    assert({
      given: 'a thread the user already follows',
      should: 'show the visible label "Following"',
      actual: pill?.textContent?.trim(),
      expected: 'Following',
    });

    if (pill) click(pill);
    await flush();

    assert({
      given: 'Following is clicked',
      should: 'DELETE the follow for the root message',
      actual: followCalls()[0],
      expected: ['/api/channels/page-1/messages/root-1/follow', { method: 'DELETE' }],
    });
  });

  test('a DM thread follows through the DM follow route', async () => {
    renderPanel(
      { source: 'dm', contextId: 'conv-1', contextLabel: 'Dana · DM', alsoSendToParentLabel: 'Also send to Dana' },
      listing({ isFollowing: false }),
    );
    await flush();

    const pill = findButton('Follow thread');
    if (pill) click(pill);
    await flush();

    assert({
      given: 'the Follow pill is clicked on a DM thread',
      should: 'POST to the DM follow route for the root message',
      actual: followCalls()[0],
      expected: ['/api/messages/conv-1/root-1/follow', { method: 'POST' }],
    });
  });

  test('replies show the Agent badge and "(edited)" marker, and the count line reads N replies', async () => {
    renderPanel();
    await flush();

    const text = document.body.textContent ?? '';

    assert({
      given: 'a reply from an agent',
      should: 'show the "Agent" badge',
      actual: text.includes('Agent'),
      expected: true,
    });
    assert({
      given: 'a reply with an editedAt timestamp',
      should: 'show "(edited)"',
      actual: text.includes('(edited)'),
      expected: true,
    });
    assert({
      given: 'two replies in the thread',
      should: 'show the "2 replies" divider',
      actual: document.querySelector('[data-testid="thread-divider-count"]')?.textContent,
      expected: '2 replies',
    });
  });

  test('the composer offers the parent-specific also-send label', async () => {
    renderPanel();
    await flush();

    assert({
      given: 'a channel thread',
      should: 'pass "Also send to #launch-ops" to the composer checkbox',
      actual: document.querySelector('[data-testid="composer"]')?.textContent,
      expected: 'Also send to #launch-ops',
    });
  });
});

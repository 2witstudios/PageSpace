// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { SWRConfig } from 'swr';
import { click, mount, unmountAll, typeInto } from '@/ui/test-support/dom';
import type { MessageablePerson } from '@/retained/lib/messages/dm-people';

const push = vi.fn();
const fetchWithAuth = vi.fn();
const post = vi.fn();
let threads: readonly { id: string; otherUserId: string | null }[] = [];

vi.mock('@/retained-adapters/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/retained-adapters/retained-provider', () => ({
  RetainedSurface: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (url: string) => fetchWithAuth(url),
  post: (url: string, body: unknown) => post(url, body),
}));
vi.mock('@/ui/messages/use-messages/use-messages', () => ({
  useDirectThreads: () => ({ threads, error: undefined, isLoading: false, retry: () => undefined }),
}));

const { default: NewConversationPage } = await import('./page');

const person = (over: Partial<MessageablePerson> & Pick<MessageablePerson, 'id' | 'source'>): MessageablePerson => ({
  name: null,
  email: `${over.id}@example.com`,
  image: null,
  username: null,
  displayName: null,
  bio: null,
  avatarUrl: null,
  sharedDriveCount: 0,
  ...over,
});

const PEOPLE = [
  person({ id: 'priya', displayName: 'Priya Shah', username: 'priya', source: 'drive', sharedDriveCount: 2 }),
  person({ id: 'dana', displayName: 'Dana Whitfield', username: 'dana', source: 'connection' }),
];

const settle = (check: () => void) => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

const show = async () => {
  fetchWithAuth.mockImplementation(async () => Response.json({ users: PEOPLE }));
  const container = mount(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <NewConversationPage />
    </SWRConfig>,
  );
  await settle(() => expect(container.textContent).toContain('Priya Shah'));
  return container;
};

const search = (container: HTMLElement) => container.querySelector('input') as HTMLInputElement;
const optionFor = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('[role="option"]')].find((el) => el.textContent?.includes(name)) as HTMLElement;
const sendButton = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Message')) as HTMLButtonElement;

afterEach(() => {
  unmountAll();
  push.mockReset();
  post.mockReset();
  fetchWithAuth.mockReset();
  threads = [];
});

describe('NewConversationPage (C-DM-New)', () => {
  test('the picker, grouped by how the viewer knows each person', async () => {
    const container = await show();

    assert({
      given: 'people who share a drive and a connection',
      should: 'show the heading, the search field and both groups',
      actual: {
        heading: container.textContent?.includes('Your connections and people who share a drive with you.'),
        placeholder: search(container).placeholder,
        groups: [...container.querySelectorAll('h2')].map((h) => h.textContent),
      },
      expected: {
        heading: true,
        placeholder: 'Search by name or @username',
        groups: ['Shares a drive with you', 'Connections'],
      },
    });
  });

  test('a search with no match', async () => {
    const container = await show();
    typeInto(search(container), 'zzz');

    assert({
      given: 'a search that matches nobody',
      should: 'name the no-match and keep the connect-or-invite footer',
      actual: {
        none: container.querySelectorAll('[role="option"]').length,
        footer: container.textContent?.includes("Can't find someone? "),
      },
      expected: { none: 0, footer: true },
    });
  });

  test('a person with an existing conversation', async () => {
    threads = [{ id: 'conv-dana', otherUserId: 'dana' }];
    const container = await show();

    assert({
      given: 'a conversation already open with Dana',
      should: 'show Open chat on her row only',
      actual: [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Open chat').length,
      expected: 1,
    });
  });

  test('a selected person', async () => {
    const container = await show();
    click(optionFor(container, 'Dana Whitfield'));

    assert({
      given: 'Dana selected',
      should: 'name the send button with her first name and mark the row selected',
      actual: { label: sendButton(container).textContent, selected: optionFor(container, 'Dana Whitfield').getAttribute('aria-selected') },
      expected: { label: 'Message Dana', selected: 'true' },
    });
  });

  test('a created conversation', async () => {
    post.mockResolvedValue({ conversation: { id: 'conv-new' } });
    const container = await show();
    click(optionFor(container, 'Priya Shah'));
    click(sendButton(container));
    await settle(() => expect(push).toHaveBeenCalledWith('/dashboard/dms/conv-new'));

    assert({
      given: 'Priya selected and sent',
      should: 'create the conversation for her and open it',
      actual: post.mock.calls[0],
      expected: ['/api/messages/conversations', { recipientId: 'priya' }],
    });
  });
});

// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import ChannelView from './ChannelView';

const fixtures = vi.hoisted(() => ({ messages: [] as unknown[], lastReadAt: null as string | null }));

vi.mock('@/retained/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'me', name: 'Jono' } }) }));
vi.mock('@/retained/hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: { canEdit: true } }),
  getPermissionErrorMessage: () => 'You cannot send here',
}));
vi.mock('@/retained/hooks/useMobile', () => ({ useMobile: () => false }));
vi.mock('@/retained/stores/useSocketStore', () => ({
  useSocketStore: (selector: (state: unknown) => unknown) =>
    selector({ socket: null, connectionStatus: 'disconnected', connect: () => {} }),
}));
vi.mock('@/retained/stores/useNotificationStore', () => ({ refetchNotificationsIfMarkedRead: () => {} }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: async () => Response.json({ messages: fixtures.messages, lastReadAt: fixtures.lastReadAt, hasMore: false }),
  post: async () => ({ success: true, notificationsMarkedRead: 0 }),
  del: async () => ({}),
  patch: async () => ({}),
  fetchJSON: async () => ({}),
}));
vi.mock('@/retained/components/shared/MessageInput', () => ({
  MessageInput: () => null,
  buildEditingSessionKey: () => 'channel:c1',
}));
vi.mock('@/retained/components/shared/PageWebhooksDialog', () => ({ PageWebhooksDialog: () => null }));
vi.mock('@/retained/components/messages/MessageLinkPreviews', () => ({ MessageLinkPreviews: () => null }));
vi.mock('@/retained/components/messages/RichText', () => ({
  RichText: ({ content }: { content: string }) => createElement('span', null, content),
  addHardLineBreaks: (value: string) => value,
}));
vi.mock('@/retained/components/ai/ui/conversation', () => ({
  Conversation: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement('div', { className }, children),
  ConversationContent: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement('div', rest, children),
  ConversationScrollButton: () => null,
}));

afterEach(() => {
  unmountAll();
  fixtures.messages = [];
  fixtures.lastReadAt = null;
});

type ViewProps = ComponentProps<typeof ChannelView>;
const page = { id: 'c1', driveId: 'd1', title: 'Launch' } as unknown as ViewProps['page'];

const message = (id: string, createdAt: string, userId: string, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  content,
  createdAt,
  userId,
  user: { id: userId, name: userId === 'me' ? 'Jono' : 'Sam', image: null },
  reactions: [],
  attachments: [],
  ...extra,
});

/** Lets the mocked fetch resolve and React flush its state, then runs the check. */
const settle = async (check: () => void): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  check();
};

describe('ChannelView', () => {
  test('renders the posts as a log', async () => {
    fixtures.messages = [message('a', '2026-10-05T08:00:00.000Z', 'them', 'Hello there')];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      assert({
        given: 'a loaded channel',
        should: 'render the messages inside a role=log region labelled Posts',
        actual: container.querySelector('[role="log"][aria-label="Posts"] [aria-label="Channel message"]') !== null,
        expected: true,
      });
    });
  });

  test('draws the "<n> new" divider before the first message after lastReadAt', async () => {
    fixtures.lastReadAt = '2026-10-05T09:00:00.000Z';
    fixtures.messages = [
      message('old', '2026-10-05T08:00:00.000Z', 'them', 'Earlier'),
      message('n1', '2026-10-05T09:30:00.000Z', 'them', 'First new'),
      message('n2', '2026-10-05T09:45:00.000Z', 'them', 'Second new'),
    ];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      const divider = container.querySelector('[role="separator"][aria-label="New messages"]');
      const next = divider?.nextElementSibling;
      assert({
        given: 'two messages after the viewer’s lastReadAt',
        should: 'show "2 new" right before the first of them',
        actual: { text: divider?.textContent ?? null, next: next?.getAttribute('data-message-id') ?? null },
        expected: { text: '2 new', next: 'n1' },
      });
    });
  });

  test('draws no divider for a channel that was never read', async () => {
    fixtures.lastReadAt = null;
    fixtures.messages = [message('a', '2026-10-05T08:00:00.000Z', 'them', 'Hello')];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      assert({
        given: 'lastReadAt is null',
        should: 'draw the message but no New messages divider',
        actual: {
          rendered: container.querySelector('[data-message-id="a"]') !== null,
          divider: container.querySelector('[aria-label="New messages"]'),
        },
        expected: { rendered: true, divider: null },
      });
    });
  });

  test('shows a pending own post as Sending…', async () => {
    fixtures.messages = [message('temp-1', '2026-10-05T10:00:00.000Z', 'me', 'Confirmed, 18th it is.')];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      const row = container.querySelector('[data-message-id="temp-1"]');
      assert({
        given: 'an optimistic row with a temp- id',
        should: 'mark the row busy and label it Sending…',
        actual: { busy: row?.getAttribute('aria-busy') ?? null, label: row?.textContent?.includes('Sending…') ?? false },
        expected: { busy: 'true', label: true },
      });
    });
  });

  test('keeps the floating Incoming Webhooks button only when this view owns it', async () => {
    fixtures.messages = [];
    const floating = mount(createElement(ChannelView, { page }));
    await settle(() => {
      assert({
        given: 'ChannelView on its own (the agent pane)',
        should: 'keep its floating Incoming Webhooks button',
        actual: floating.querySelector('button[aria-label="Incoming Webhooks"]') !== null,
        expected: true,
      });
    });
    unmountAll();
    const stripped = mount(createElement(ChannelView, { page, floatingWebhooks: false }));
    await settle(() => {
      assert({
        given: 'ChannelView inside the Files channel page',
        should: 'not draw its own Webhooks button (the strip has it)',
        actual: stripped.querySelector('button[aria-label="Incoming Webhooks"]'),
        expected: null,
      });
    });
  });
});

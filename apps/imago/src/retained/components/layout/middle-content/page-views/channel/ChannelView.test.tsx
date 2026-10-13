// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import ChannelView from './ChannelView';

const fixtures = vi.hoisted(() => ({
  messages: [] as unknown[],
  lastReadAt: null as string | null,
  inputProps: null as Record<string, unknown> | null,
}));

vi.mock('@/retained/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'me', name: 'Jono' } }) }));
vi.mock('@/retained/hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: { canEdit: true, canView: true } }),
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
  MessageInput: (props: Record<string, unknown>) => {
    fixtures.inputProps = props;
    return null;
  },
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

describe('ChannelView posts and composer copy', () => {
  test('gives the composer the channel placeholder', async () => {
    fixtures.inputProps = null;
    mount(createElement(ChannelView, { page }));
    await settle(() => {
      assert({
        given: 'a channel named Launch',
        should: 'ask the composer to message #Launch with the mention hint',
        actual: fixtures.inputProps?.placeholder ?? null,
        expected: 'Message #Launch — @ to mention a person, page or agent',
      });
    });
  });

  test('labels an agent post with an Agent badge', async () => {
    fixtures.messages = [
      message('ag', '2026-10-05T08:00:00.000Z', 'them', 'Morning digest', {
        userId: null,
        user: null,
        aiMeta: { senderType: 'agent', senderName: 'Launch Agent' },
      }),
    ];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      assert({
        given: 'a post from an agent',
        should: 'show the Agent badge beside the agent name',
        actual: container.querySelector('[data-message-id="ag"]')?.textContent?.includes('Agent') ?? false,
        expected: true,
      });
    });
  });

  test('marks an edited post as (edited)', async () => {
    fixtures.messages = [
      message('e1', '2026-10-05T08:00:00.000Z', 'them', 'Fixed copy', { editedAt: '2026-10-05T08:05:00.000Z' }),
    ];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      assert({
        given: 'a message with an editedAt time',
        should: 'show the (edited) marker',
        actual: container.querySelector('[data-message-id="e1"]')?.textContent?.includes('(edited)') ?? false,
        expected: true,
      });
    });
  });

  test('summarises a thread as "N replies · Last reply <time>"', async () => {
    fixtures.messages = [
      message('t1', '2026-10-05T08:00:00.000Z', 'them', 'Root', {
        replyCount: 5,
        lastReplyAt: '2026-10-05T18:03:00.000Z',
      }),
    ];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      const summary = container.querySelector('[data-testid="thread-footer-t1"]')?.textContent ?? '';
      assert({
        given: 'a root with five replies and a last reply time',
        should: 'read "5 replies · Last reply <time>" with no relative age',
        actual: { replies: summary.startsWith('5 replies · Last reply '), relative: /ago/.test(summary) },
        expected: { replies: true, relative: false },
      });
    });
  });

  test('gives each reaction row an Add reaction control', async () => {
    fixtures.messages = [
      message('r1', '2026-10-05T08:00:00.000Z', 'them', 'Ship it', {
        reactions: [{ id: 'x1', emoji: '👍', userId: 'them', user: { id: 'them', name: 'Sam' } }],
      }),
    ];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      assert({
        given: 'a message with a reaction chip and a viewer who can react',
        should: 'show an "Add reaction" button beside the chips',
        actual: container.querySelector('[data-message-id="r1"] button[aria-label="Add reaction"]') !== null,
        expected: true,
      });
    });
  });

  test('draws no "new" divider once every post is read', async () => {
    fixtures.lastReadAt = '2026-10-05T10:00:00.000Z';
    fixtures.messages = [message('seen', '2026-10-05T09:00:00.000Z', 'them', 'Already read')];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      assert({
        given: 'lastReadAt is after the newest post',
        should: 'draw no New messages divider',
        actual: container.querySelector('[aria-label="New messages"]'),
        expected: null,
      });
    });
  });

  test('shows the reaction chip with its count once a reaction is added', async () => {
    fixtures.messages = [
      message('r2', '2026-10-05T08:00:00.000Z', 'them', 'Ship it', {
        reactions: [{ id: 'x2', emoji: '👍', userId: 'me', user: { id: 'me', name: 'Jono' } }],
      }),
    ];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      const chip = container.querySelector('[data-message-id="r2"] button[aria-label="Add reaction"]')?.previousElementSibling;
      assert({
        given: 'the viewer has reacted with a thumbs up',
        should: 'show the 👍 chip with a count of 1 before the Add reaction control',
        actual: chip?.textContent ?? null,
        expected: '👍1',
      });
    });
  });

  test('labels a file attachment card Download <file name>', async () => {
    fixtures.messages = [
      message('f1', '2026-10-05T08:00:00.000Z', 'them', 'Here it is', {
        attachments: [
          {
            fileId: 'file-1',
            position: 0,
            attachmentMeta: { originalName: 'onboarding-v3.pdf', mimeType: 'application/pdf', size: 2400000 },
          },
        ],
      }),
    ];
    const container = mount(createElement(ChannelView, { page }));
    await settle(() => {
      assert({
        given: 'a PDF attached to a post',
        should: 'expose its card as a Download control named for the file',
        actual: container.querySelector('a[aria-label="Download onboarding-v3.pdf"]') !== null,
        expected: true,
      });
    });
  });
});

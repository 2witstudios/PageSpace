import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

import type { FileAttachment } from '@/hooks/useAttachmentUpload';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useParams: () => ({ conversationId: 'conv-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const mockUser = { id: 'user-me', name: 'Me', email: 'me@x.test', image: null };
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

// Controllable socket mock
type Handler = (...args: unknown[]) => void;
const socketHandlers: Record<string, Handler[]> = {};
const fakeSocket = {
  emit: vi.fn(),
  on: vi.fn((event: string, handler: Handler) => {
    socketHandlers[event] = (socketHandlers[event] ?? []).concat(handler);
  }),
  off: vi.fn((event: string, handler: Handler) => {
    socketHandlers[event] = (socketHandlers[event] ?? []).filter((h) => h !== handler);
  }),
};
vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => fakeSocket,
}));

// auth-fetch
const mockPost = vi.fn<(url: string, body?: unknown) => Promise<unknown>>(
  async () => ({}),
);
const mockPatch = vi.fn<(url: string, body?: unknown) => Promise<unknown>>(
  async () => ({}),
);
const mockDel = vi.fn<(url: string, body?: unknown) => Promise<unknown>>(
  async () => ({}),
);
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (url: string, body?: unknown) => mockPost(url, body),
  patch: (url: string, body?: unknown) => mockPatch(url, body),
  del: (url: string, body?: unknown) => mockDel(url, body),
  fetchWithAuth: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

// SWR — return controllable data per URL
type SwrData = { messages: unknown[] } | { conversation: unknown } | undefined;
let swrMessages: SwrData = { messages: [] };
const swrConversation: SwrData = {
  conversation: {
    id: 'conv-1',
    participant1Id: 'user-me',
    participant2Id: 'user-other',
    otherUser: {
      id: 'user-other',
      name: 'Bob',
      email: 'bob@x.test',
      image: null,
      username: 'bob',
      displayName: 'Bob',
      avatarUrl: null,
    },
  },
};
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (!key) return { data: undefined };
    if (key.includes('/conversations/')) return { data: swrConversation };
    return { data: swrMessages };
  },
}));

// MessagePartRenderer — render content as plain text for assertions
vi.mock('@/components/messages/MessagePartRenderer', () => ({
  renderMessageParts: (parts: Array<{ text?: string }>) =>
    parts?.[0]?.text ?? null,
  convertToMessageParts: (content: string) =>
    content ? [{ type: 'text', text: content }] : [],
}));

// MessageAttachment — sentinel for inspection
const messageAttachmentCalls = vi.fn();
vi.mock('@/components/shared/MessageAttachment', () => ({
  MessageAttachment: ({ message }: { message: { fileId?: string | null } }) => {
    messageAttachmentCalls(message);
    if (!message.fileId) return null;
    return <div data-testid={`attachment-${message.fileId}`}>attachment</div>;
  },
}));

// ChannelInput — capture props so tests can drive onSend / inspect conversationId
type ChannelInputProps = {
  value: string;
  onChange: (v: string) => void;
  onSend: (a?: FileAttachment) => void;
  conversationId?: string;
  channelId?: string;
  attachmentsEnabled?: boolean;
};
const { lastChannelInputPropsRef } = vi.hoisted(() => ({
  lastChannelInputPropsRef: { current: null as ChannelInputProps | null },
}));
vi.mock(
  '@/components/layout/middle-content/page-views/channel/ChannelInput',
  () => {
    const Mock = React.forwardRef<unknown, ChannelInputProps>(
      (props, _ref) => {
        lastChannelInputPropsRef.current = props;
        return (
          <div data-testid="channel-input-mock">
            <button
              data-testid="send-text-only"
              onClick={() => props.onSend(undefined)}
            />
            <button
              data-testid="send-with-attachment"
              onClick={() =>
                props.onSend({
                  id: 'file-x',
                  originalName: 'pic.png',
                  size: 1024,
                  mimeType: 'image/png',
                  contentHash: 'hash-x',
                })
              }
            />
          </div>
        );
      },
    );
    Mock.displayName = 'MockChannelInput';
    return { ChannelInput: Mock };
  },
);

// ── Module under test (import after mocks) ────────────────────────────
import InboxDMPage from '../page';

const sampleAttachment: FileAttachment = {
  id: 'file-x',
  originalName: 'pic.png',
  size: 1024,
  mimeType: 'image/png',
  contentHash: 'hash-x',
};

describe('InboxDMPage — attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(socketHandlers).forEach((k) => delete socketHandlers[k]);
    swrMessages = { messages: [] };
    lastChannelInputPropsRef.current = null;
  });

  it('passesConversationId_andEnablesAttachments_onChannelInput', async () => {
    await act(async () => {
      render(<InboxDMPage />);
    });
    expect(lastChannelInputPropsRef.current).not.toBeNull();
    expect(lastChannelInputPropsRef.current!.conversationId).toBe('conv-1');
    expect(lastChannelInputPropsRef.current!.attachmentsEnabled).toBe(true);
  });

  it('sendWithAttachment_postsBodyIncludesFileIdAndAttachmentMeta', async () => {
    await act(async () => {
      render(<InboxDMPage />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('send-with-attachment'));
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const call = mockPost.mock.calls[0];
    expect(call[0]).toBe('/api/messages/conv-1');
    expect(call[1]).toMatchObject({
      fileId: sampleAttachment.id,
      attachmentMeta: {
        originalName: sampleAttachment.originalName,
        size: sampleAttachment.size,
        mimeType: sampleAttachment.mimeType,
        contentHash: sampleAttachment.contentHash,
      },
    });
  });

  it('sendWithoutAttachment_postsBodyOmitsFileFields', async () => {
    swrMessages = { messages: [] };
    await act(async () => {
      render(<InboxDMPage />);
    });

    // Set inputValue via ChannelInput.onChange so handleSendMessage has content
    await act(async () => {
      lastChannelInputPropsRef.current!.onChange('hello');
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-text-only'));
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const call = mockPost.mock.calls[0];
    expect(call[0]).toBe('/api/messages/conv-1');
    const body = call[1] as { content?: string; fileId?: unknown; attachmentMeta?: unknown };
    expect(body).toMatchObject({ content: 'hello' });
    expect(body.fileId).toBeUndefined();
    expect(body.attachmentMeta).toBeUndefined();
  });

  it('renderMessage_withFileId_rendersMessageAttachment', async () => {
    swrMessages = {
      messages: [
        {
          id: 'm1',
          conversationId: 'conv-1',
          senderId: 'user-other',
          content: 'here is the file',
          isRead: false,
          readAt: null,
          isEdited: false,
          editedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
          fileId: 'file-rendered',
          attachmentMeta: {
            originalName: 'doc.pdf',
            size: 5,
            mimeType: 'application/pdf',
            contentHash: 'h',
          },
        },
      ],
    };

    await act(async () => {
      render(<InboxDMPage />);
    });

    expect(screen.getByTestId('attachment-file-rendered')).toBeInTheDocument();
  });

  it('renderMessage_withoutFileId_doesNotRenderMessageAttachment', async () => {
    swrMessages = {
      messages: [
        {
          id: 'm2',
          conversationId: 'conv-1',
          senderId: 'user-me',
          content: 'plain text',
          isRead: false,
          readAt: null,
          isEdited: false,
          editedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
          fileId: null,
          attachmentMeta: null,
        },
      ],
    };

    await act(async () => {
      render(<InboxDMPage />);
    });

    // The MessageAttachment mock returns null when fileId is missing; assert no
    // attachment node exists for any id.
    expect(
      document.querySelector('[data-testid^="attachment-"]'),
    ).toBeNull();
  });

  it('optimisticAppend_includesAttachmentFields_onLocalEcho', async () => {
    await act(async () => {
      render(<InboxDMPage />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('send-with-attachment'));
    });

    // Optimistic append should immediately render the attachment for the
    // freshly-sent message, before the realtime echo arrives.
    expect(screen.getByTestId('attachment-file-x')).toBeInTheDocument();
  });

  it('realtimeNewDmMessage_withAttachment_appendsRowAndRendersAttachment_withoutRefetch', async () => {
    await act(async () => {
      render(<InboxDMPage />);
    });

    // Fire the real-time event the way the realtime service does
    const handlers = socketHandlers['new_dm_message'] ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    await act(async () => {
      handlers.forEach((h) =>
        h({
          id: 'm-rt',
          conversationId: 'conv-1',
          senderId: 'user-other',
          content: 'realtime',
          isRead: false,
          readAt: null,
          isEdited: false,
          editedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
          fileId: 'file-rt',
          attachmentMeta: {
            originalName: 'rt.png',
            size: 9,
            mimeType: 'image/png',
            contentHash: 'h',
          },
        }),
      );
    });

    expect(screen.getByTestId('attachment-file-rt')).toBeInTheDocument();
  });
});

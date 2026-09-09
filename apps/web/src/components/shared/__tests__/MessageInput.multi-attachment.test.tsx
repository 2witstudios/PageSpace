/**
 * Regression test for "sending multiple photos sends them twice until refresh".
 *
 * The composer used to fan one send out into N messages — the first carrying
 * the text and the first file, each remaining file getting its own empty-text
 * message. Every one of those `onSubmit` calls ran synchronously in the same
 * tick, so each surface minted its optimistic row id from `Date.now()` and the
 * whole batch shared one id. That id is the React key; duplicate keys collapse
 * into a single entry during reconciliation, so when the server confirmations
 * arrived only one of the duplicate-keyed fibers was removed and the rest were
 * stranded on screen next to the real rows.
 *
 * Asserting the CALL COUNT is the point. A test that only checked the payload
 * would pass just as happily against the fan-out.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

const attachmentsInComposer = [
  {
    instanceId: 'i-1',
    id: 'file-1',
    originalName: 'one.png',
    size: 10,
    mimeType: 'image/png',
    contentHash: 'a'.repeat(64),
  },
  {
    instanceId: 'i-2',
    id: 'file-2',
    originalName: 'two.png',
    size: 20,
    mimeType: 'image/png',
    contentHash: 'b'.repeat(64),
  },
  {
    instanceId: 'i-3',
    id: 'file-3',
    originalName: 'three.png',
    size: 30,
    mimeType: 'image/png',
    contentHash: 'c'.repeat(64),
  },
];

vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_t, prop: string) =>
        ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
          React.createElement(
            prop as keyof React.JSX.IntrinsicElements,
            Object.fromEntries(
              Object.entries(props).filter(([k]) => !/^(initial|animate|exit|while|transition|layout)/.test(k)),
            ),
            children,
          ),
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
}));

vi.mock('@/components/ai/chat/input/ChatTextarea', () => {
  const MockChatTextarea = React.forwardRef<
    { focus: () => void; clear: () => void },
    { value: string; onChange: (v: string) => void; onSend: () => void }
  >((props, ref) => {
    React.useImperativeHandle(ref, () => ({ focus: vi.fn(), clear: vi.fn() }));
    return (
      <textarea
        data-testid="chat-textarea"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSend();
          }
        }}
      />
    );
  });
  MockChatTextarea.displayName = 'MockChatTextarea';
  return { ChatTextarea: MockChatTextarea };
});

// The composer holds three uploaded files, as it would after picking three
// photos — uploads already ran, so only the send path is under test.
vi.mock('@/hooks/useAttachmentUpload', () => ({
  useAttachmentUpload: () => ({
    attachments: attachmentsInComposer,
    attachment: attachmentsInComposer[0],
    isUploading: false,
    uploadFile: vi.fn(),
    uploadFiles: vi.fn(),
    clearAttachment: vi.fn(),
    removeAttachment: vi.fn(),
  }),
}));

import { MessageInput, type MessageInputSubmit } from '../MessageInput';

const Harness = ({ onSubmit, initialValue = '' }: {
  onSubmit: (info: MessageInputSubmit) => void;
  initialValue?: string;
}) => {
  const [value, setValue] = React.useState(initialValue);
  return (
    <MessageInput
      source="channel"
      contextId="page-1"
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
    />
  );
};

const send = async (onSubmit: ReturnType<typeof vi.fn>, initialValue = '') => {
  const user = userEvent.setup();
  render(<Harness onSubmit={onSubmit} initialValue={initialValue} />);
  await user.type(screen.getByTestId('chat-textarea'), '{enter}');
};

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('MessageInput with several attachments', () => {
  it('sends exactly one message for a batch of three photos', async () => {
    const onSubmit = vi.fn();
    await send(onSubmit);

    assert({
      given: 'three photos attached to one compose',
      should: 'call onSubmit once — the N-call fan-out is what duplicated rows on screen',
      actual: onSubmit.mock.calls.length,
      expected: 1,
    });
  });

  it('carries every file on that one message, in the order attached', async () => {
    const onSubmit = vi.fn();
    await send(onSubmit);

    assert({
      given: 'three photos attached to one compose',
      should: 'pass all three through in order, since position is the display order',
      actual: onSubmit.mock.calls[0]?.[0]?.attachments?.map((a: { id: string }) => a.id),
      expected: ['file-1', 'file-2', 'file-3'],
    });
  });

  it('keeps the typed text on the same message as the photos', async () => {
    const onSubmit = vi.fn();
    await send(onSubmit, 'look at these');

    assert({
      given: 'text typed alongside three photos',
      should: 'send one message carrying both — the text used to be split onto its own message',
      actual: {
        calls: onSubmit.mock.calls.length,
        content: onSubmit.mock.calls[0]?.[0]?.content,
        attachmentCount: onSubmit.mock.calls[0]?.[0]?.attachments?.length,
      },
      expected: { calls: 1, content: 'look at these', attachmentCount: 3 },
    });
  });
});

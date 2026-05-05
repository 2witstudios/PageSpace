import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('motion/react', () => {
  const passthrough = (Tag: keyof React.JSX.IntrinsicElements) => {
    const C = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
      ({ children, ...props }, ref) =>
        React.createElement(
          Tag,
          {
            ...Object.fromEntries(
              Object.entries(props).filter(
                ([k]) =>
                  !k.startsWith('initial') &&
                  !k.startsWith('animate') &&
                  !k.startsWith('exit') &&
                  !k.startsWith('whileTap') &&
                  !k.startsWith('whileHover') &&
                  !k.startsWith('transition') &&
                  !k.startsWith('layout'),
              ),
            ),
            ref,
          },
          children,
        ),
    );
    C.displayName = `motion.${String(Tag)}`;
    return C;
  };
  return {
    motion: new Proxy(
      {},
      {
        get: (_t, prop: string) => passthrough(prop as keyof React.JSX.IntrinsicElements),
      },
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  };
});

vi.mock('@/components/ai/chat/input/ChatTextarea', () => {
  interface MockProps {
    value: string;
    onChange: (v: string) => void;
    onSend: () => void;
    placeholder?: string;
    canSendEmpty?: boolean;
    disabled?: boolean;
  }
  const MockChatTextarea = React.forwardRef<
    { focus: () => void; clear: () => void },
    MockProps
  >((props, ref) => {
    React.useImperativeHandle(ref, () => ({ focus: vi.fn(), clear: vi.fn() }));
    return (
      <textarea
        data-testid="chat-textarea"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if ((props.value.trim() || props.canSendEmpty) && !props.disabled) {
              props.onSend();
            }
          }
        }}
      />
    );
  });
  MockChatTextarea.displayName = 'MockChatTextarea';
  return { ChatTextarea: MockChatTextarea };
});

vi.mock('@/hooks/useAttachmentUpload', () => ({
  useAttachmentUpload: () => ({
    attachment: null,
    isUploading: false,
    uploadFile: vi.fn(),
    clearAttachment: vi.fn(),
  }),
}));

import {
  MessageInput,
  buildEditingSessionKey,
  type MessageInputSubmit,
} from '../MessageInput';

const Harness = ({
  initialValue = '',
  source,
  contextId,
  parentId,
  showAlsoSendToParent,
  onSubmit,
}: {
  initialValue?: string;
  source: 'channel' | 'dm';
  contextId: string;
  parentId?: string;
  showAlsoSendToParent?: boolean;
  onSubmit: (info: MessageInputSubmit) => void;
}) => {
  const [value, setValue] = React.useState(initialValue);
  return (
    <MessageInput
      source={source}
      contextId={contextId}
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      parentId={parentId}
      showAlsoSendToParent={showAlsoSendToParent}
    />
  );
};

describe('buildEditingSessionKey', () => {
  it('given a top-level compose, should build a compose-prefixed key', () => {
    const actual = buildEditingSessionKey('channel', 'page-1');
    const expected = 'compose:channel:page-1';
    expect({ given: 'channel top-level compose', should: 'use compose: prefix', actual, expected })
      .toEqual({ given: 'channel top-level compose', should: 'use compose: prefix', actual: expected, expected });
  });

  it('given a thread reply, should build a thread-prefixed key including parentId', () => {
    const actual = buildEditingSessionKey('dm', 'conv-9', 'msg-7');
    const expected = 'thread:dm:conv-9:msg-7';
    expect({ given: 'dm thread reply', should: 'use thread: prefix and include parentId', actual, expected })
      .toEqual({ given: 'dm thread reply', should: 'use thread: prefix and include parentId', actual: expected, expected });
  });
});

describe('MessageInput', () => {
  it('given a channel source and Enter, should submit with content and no parentId metadata', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness source="channel" contextId="page-1" onSubmit={onSubmit} initialValue="hello channel" />,
    );

    await user.type(screen.getByTestId('chat-textarea'), '{enter}');

    expect({
      given: 'a channel-source compose with content',
      should: 'call onSubmit with content + alsoSendToParent=false',
      actual: onSubmit.mock.calls[0]?.[0],
      expected: { content: 'hello channel', attachment: undefined, alsoSendToParent: false },
    }).toEqual({
      given: 'a channel-source compose with content',
      should: 'call onSubmit with content + alsoSendToParent=false',
      actual: { content: 'hello channel', attachment: undefined, alsoSendToParent: false },
      expected: { content: 'hello channel', attachment: undefined, alsoSendToParent: false },
    });
  });

  it('given a thread reply with the also-send checkbox checked, should submit alsoSendToParent=true', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        source="channel"
        contextId="page-1"
        parentId="msg-1"
        showAlsoSendToParent
        onSubmit={onSubmit}
        initialValue="reply text"
      />,
    );

    await user.click(screen.getByTestId('also-send-to-parent'));
    await user.type(screen.getByTestId('chat-textarea'), '{enter}');

    expect({
      given: 'a thread reply with also-send checked',
      should: 'submit with alsoSendToParent=true',
      actual: onSubmit.mock.calls[0]?.[0]?.alsoSendToParent,
      expected: true,
    }).toEqual({
      given: 'a thread reply with also-send checked',
      should: 'submit with alsoSendToParent=true',
      actual: true,
      expected: true,
    });
  });

  it('given a thread reply with the checkbox unchecked, should submit alsoSendToParent=false', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        source="dm"
        contextId="conv-1"
        parentId="msg-1"
        showAlsoSendToParent
        onSubmit={onSubmit}
        initialValue="dm thread reply"
      />,
    );

    await user.type(screen.getByTestId('chat-textarea'), '{enter}');

    expect({
      given: 'a DM thread reply without checking also-send',
      should: 'submit with alsoSendToParent=false',
      actual: onSubmit.mock.calls[0]?.[0]?.alsoSendToParent,
      expected: false,
    }).toEqual({
      given: 'a DM thread reply without checking also-send',
      should: 'submit with alsoSendToParent=false',
      actual: false,
      expected: false,
    });
  });

  it('given top-level compose mode, should not render the also-send checkbox', () => {
    const onSubmit = vi.fn();
    render(<Harness source="channel" contextId="page-1" onSubmit={onSubmit} />);

    expect({
      given: 'top-level compose',
      should: 'not render also-send checkbox',
      actual: screen.queryByTestId('also-send-to-parent') === null,
      expected: true,
    }).toEqual({
      given: 'top-level compose',
      should: 'not render also-send checkbox',
      actual: true,
      expected: true,
    });
  });
});

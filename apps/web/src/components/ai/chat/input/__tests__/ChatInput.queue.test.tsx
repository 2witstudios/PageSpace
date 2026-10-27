import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';

vi.mock('@/stores/useAssistantSettingsStore', () => ({
  useAssistantSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      webSearchEnabled: false,
      writeMode: false,
      showPageTree: false,
      toggleWebSearch: vi.fn(),
      toggleWriteMode: vi.fn(),
      toggleShowPageTree: vi.fn(),
      currentProvider: 'anthropic',
      currentModel: 'claude-opus-4-7',
      setProviderSettings: vi.fn(),
      loadSettings: vi.fn(),
    }),
}));

vi.mock('@/hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    isListening: false,
    isSupported: false,
    error: null,
    toggleListening: vi.fn(),
    clearError: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMobileKeyboard', () => ({
  useMobileKeyboard: () => ({ dismiss: vi.fn() }),
}));

/**
 * ChatTextarea is mocked because driving its real slash-command parser is out
 * of scope here — what this suite needs is a composer that can (a) call
 * onSend the way Enter does, (b) optionally swallow Escape on the capture
 * phase the way suggestion/mention pickers do.
 */
let preventNextEscape = false;

vi.mock('../ChatTextarea', () => ({
  ChatTextarea: ({
    disabled,
    value,
    onSend,
  }: {
    disabled?: boolean;
    value: string;
    onSend?: () => void;
  }) => (
    <div>
      <textarea
        data-testid="chat-textarea"
        disabled={disabled}
        value={value}
        readOnly
        onKeyDownCapture={(e) => {
          if (preventNextEscape) e.preventDefault();
        }}
      />
      <button type="button" data-testid="mock-enter" onClick={() => onSend?.()}>
        enter
      </button>
    </div>
  ),
}));

vi.mock('../AttachButton', () => ({
  AttachButton: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="attach-button" data-disabled={String(disabled ?? false)} />
  ),
}));

vi.mock('../AttachmentPreviewStrip', () => ({
  AttachmentPreviewStrip: () => null,
}));

vi.mock('@/components/ui/floating-input', () => ({
  InputFooter: ({ disabled }: { disabled: boolean }) => (
    <div data-testid="input-footer" data-disabled={String(disabled)} />
  ),
}));

// InputActions and QueueTray are deliberately REAL: the queue affordance and
// the tray are the feature.

import { ChatInput } from '../ChatInput';

const baseProps = {
  value: '',
  onChange: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  isStreaming: false,
};

const queueProps = {
  queuedMessages: [] as Array<{ id: string; role: 'user'; parts: Array<{ type: 'text'; text: string }> }>,
  onEnqueue: vi.fn(),
  onRemoveQueued: vi.fn(),
  onClearQueued: vi.fn(),
  onCancelQueue: vi.fn(),
};

const queued = (id: string, text: string) => ({
  id,
  role: 'user' as const,
  parts: [{ type: 'text' as const, text }],
});

const pressEscape = (): void => {
  fireEvent.keyDown(screen.getByTestId('chat-textarea'), { key: 'Escape' });
};

beforeEach(() => {
  vi.clearAllMocks();
  preventNextEscape = false;
});

describe('ChatInput — queue send (issue #2676)', () => {
  it('given streaming and the queue wired, Enter-equivalent QUEUES the message', () => {
    render(<ChatInput {...baseProps} value="next question" isStreaming {...queueProps} />);

    fireEvent.click(screen.getByTestId('mock-enter'));

    expect(queueProps.onEnqueue).toHaveBeenCalledTimes(1);
    expect(baseProps.onSend).not.toHaveBeenCalled();
  });

  it('given streaming and the queue NOT wired, Enter-equivalent sends nothing (pre-#2676 behavior)', () => {
    render(<ChatInput {...baseProps} value="hello" isStreaming />);

    fireEvent.click(screen.getByTestId('mock-enter'));

    expect(baseProps.onSend).not.toHaveBeenCalled();
    expect(queueProps.onEnqueue).not.toHaveBeenCalled();
  });

  it('given streaming with a full queue, Enter-equivalent queues nothing', () => {
    render(
      <ChatInput
        {...baseProps}
        value="one more"
        isStreaming
        {...queueProps}
        queuedMessages={[queued('q1', 'one'), queued('q2', 'two'), queued('q3', 'three')]}
        isQueueFull
      />,
    );

    fireEvent.click(screen.getByTestId('mock-enter'));
    expect(queueProps.onEnqueue).not.toHaveBeenCalled();

    // The affordance says why, rather than going silently inert.
    expect(screen.getByTestId('chat-queue-send')).toBeDisabled();
    expect(screen.getByTestId('chat-queue-send')).toHaveAttribute(
      'title',
      expect.stringContaining('full'),
    );
  });

  it('given streaming with attachments attached, the send is refused (text-only v1)', () => {
    render(
      <ChatInput
        {...baseProps}
        value="look at this"
        isStreaming
        hasVision
        onAddFiles={vi.fn()}
        attachments={[{ id: 'a1', file: new File([], 'x.png'), previewUrl: 'blob:x' } as never]}
        {...queueProps}
      />,
    );

    fireEvent.click(screen.getByTestId('mock-enter'));
    expect(queueProps.onEnqueue).not.toHaveBeenCalled();
    expect(baseProps.onSend).not.toHaveBeenCalled();
  });

  it('given streaming with /btw, the side-question path wins over the queue', () => {
    const onSideQuestion = vi.fn();
    render(
      <ChatInput
        {...baseProps}
        value="/btw separate thing"
        isStreaming
        onSideQuestion={onSideQuestion}
        {...queueProps}
      />,
    );

    fireEvent.click(screen.getByTestId('mock-enter'));
    expect(onSideQuestion).toHaveBeenCalledTimes(1);
    expect(queueProps.onEnqueue).not.toHaveBeenCalled();
  });

  it('given the observer lock, the queue is inert even while streaming and wired', () => {
    render(
      <ChatInput
        {...baseProps}
        value="hello"
        isStreaming
        remoteStreamingUser={{ userId: 'u-alice', displayName: 'Alice' }}
        {...queueProps}
      />,
    );

    fireEvent.click(screen.getByTestId('mock-enter'));
    expect(queueProps.onEnqueue).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-queue-send')).toBeDisabled();
  });

  it('given not streaming, Enter-equivalent SENDS and never queues', () => {
    render(<ChatInput {...baseProps} value="hello" {...queueProps} />);

    fireEvent.click(screen.getByTestId('mock-enter'));
    expect(baseProps.onSend).toHaveBeenCalledTimes(1);
    expect(queueProps.onEnqueue).not.toHaveBeenCalled();

    // No queue affordance when idle — the queue button is a streaming-state control.
    expect(screen.queryByTestId('chat-queue-send')).toBeNull();
  });

  it('the queue-send button itself queues, shows the count badge, and is disabled when it cannot queue', () => {
    const { rerender } = render(
      <ChatInput {...baseProps} value="typed while streaming" isStreaming {...queueProps} />,
    );

    const queueButton = screen.getByTestId('chat-queue-send');
    expect(queueButton).toBeEnabled();
    expect(screen.queryByTestId('chat-queue-count')).toBeNull();
    fireEvent.click(queueButton);
    expect(queueProps.onEnqueue).toHaveBeenCalledTimes(1);

    rerender(
      <ChatInput
        {...baseProps}
        value=""
        isStreaming
        {...queueProps}
        queuedMessages={[queued('q1', 'one')]}
      />,
    );
    expect(screen.getByTestId('chat-queue-count')).toHaveTextContent('1');
    // Nothing typed: nothing to queue.
    expect(screen.getByTestId('chat-queue-send')).toBeDisabled();
  });
});

describe('ChatInput — Escape during a stream', () => {
  it('a single Escape stops the stream; it does not cancel the queue', () => {
    render(<ChatInput {...baseProps} value="hello" isStreaming {...queueProps} />);

    pressEscape();

    expect(baseProps.onStop).toHaveBeenCalledTimes(1);
    expect(queueProps.onCancelQueue).not.toHaveBeenCalled();
  });

  it('a second Escape within the window is the interrupt: clear queue + cancel the pending drain', () => {
    render(<ChatInput {...baseProps} value="hello" isStreaming {...queueProps} />);

    pressEscape();
    pressEscape();

    expect(baseProps.onStop).toHaveBeenCalledTimes(1);
    expect(queueProps.onCancelQueue).toHaveBeenCalledTimes(1);
  });

  it('Escape while the stop is still resolving goes straight to the interrupt', () => {
    render(
      <ChatInput {...baseProps} value="hello" isStreaming isStopping {...queueProps} />,
    );

    pressEscape();

    expect(baseProps.onStop).not.toHaveBeenCalled();
    expect(queueProps.onCancelQueue).toHaveBeenCalledTimes(1);
  });

  it('Escape while not streaming stops nothing and cancels nothing', () => {
    render(<ChatInput {...baseProps} value="hello" {...queueProps} />);

    pressEscape();

    expect(baseProps.onStop).not.toHaveBeenCalled();
    expect(queueProps.onCancelQueue).not.toHaveBeenCalled();
  });

  it('an Escape already consumed by a picker (defaultPrevented) reaches neither stop nor cancel', () => {
    render(<ChatInput {...baseProps} value="hello" isStreaming {...queueProps} />);

    preventNextEscape = true;
    pressEscape();

    expect(baseProps.onStop).not.toHaveBeenCalled();
    expect(queueProps.onCancelQueue).not.toHaveBeenCalled();
  });
});

describe('ChatInput — the queue tray', () => {
  it('lists queued entries in order, with remove and clear-all wired', () => {
    render(
      <ChatInput
        {...baseProps}
        isStreaming
        {...queueProps}
        queuedMessages={[queued('q1', 'first'), queued('q2', 'second')]}
      />,
    );

    const tray = screen.getByTestId('queue-tray');
    const items = within(tray).getAllByTestId('queue-tray-item');
    expect(items).toHaveLength(2);
    // Items render with their position prefix; order is what matters.
    expect(items[0].textContent).toContain('first');
    expect(items[1].textContent).toContain('second');

    fireEvent.click(within(items[0]).getByTestId('queue-tray-remove-q1'));
    expect(queueProps.onRemoveQueued).toHaveBeenCalledWith('q1');

    fireEvent.click(screen.getByTestId('queue-tray-clear'));
    expect(queueProps.onClearQueued).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the queue is empty, and nothing at all when the queue is not wired', () => {
    const { rerender } = render(
      <ChatInput {...baseProps} isStreaming {...queueProps} queuedMessages={[]} />,
    );
    expect(screen.queryByTestId('queue-tray')).toBeNull();

    // Not wired: no tray even if a list were somehow passed.
    rerender(
      <ChatInput
        {...baseProps}
        isStreaming
        queuedMessages={[queued('q1', 'orphan')]}
      />,
    );
    expect(screen.queryByTestId('queue-tray')).toBeNull();
  });
});

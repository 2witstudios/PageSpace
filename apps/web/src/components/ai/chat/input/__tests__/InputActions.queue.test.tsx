import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputActions } from '../InputActions';

const baseProps = {
  isStreaming: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
};

/**
 * The queue-send affordance (issue #2676) is the visible half of "typing while
 * the AI replies". If it ever silently disappears, the composer goes back to
 * swallowing Enter mid-stream — the exact UX the issue was filed about.
 */
describe('InputActions — queue send affordance', () => {
  it('while streaming with the queue wired, shows Stop AND the queue-send button with a count badge', () => {
    render(
      <InputActions
        {...baseProps}
        isStreaming
        onQueueSend={vi.fn()}
        canQueue
        queuedCount={2}
      />,
    );

    expect(screen.getByTestId('chat-stop')).toBeInTheDocument();
    expect(screen.getByTestId('chat-queue-send')).toBeEnabled();
    expect(screen.getByTestId('chat-queue-count')).toHaveTextContent('2');
  });

  it('while streaming WITHOUT the queue wired, shows Stop only — as before #2676', () => {
    render(<InputActions {...baseProps} isStreaming />);

    expect(screen.getByTestId('chat-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-queue-send')).toBeNull();
  });

  it('while idle, shows the ordinary send button and no queue button', () => {
    render(<InputActions {...baseProps} onQueueSend={vi.fn()} canQueue queuedCount={1} />);

    expect(screen.getByTestId('chat-send')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-queue-send')).toBeNull();
    expect(screen.queryByTestId('chat-queue-count')).toBeNull();
  });

  it('clicking the queue-send button queues (and only queues)', () => {
    const onQueueSend = vi.fn();
    render(
      <InputActions {...baseProps} isStreaming onQueueSend={onQueueSend} canQueue queuedCount={1} />,
    );

    fireEvent.click(screen.getByTestId('chat-queue-send'));
    expect(onQueueSend).toHaveBeenCalledTimes(1);
    expect(baseProps.onStop).not.toHaveBeenCalled();
  });

  it('cannot queue when canQueue is false — disabled with the no-op guard kept', () => {
    const onQueueSend = vi.fn();
    render(<InputActions {...baseProps} isStreaming onQueueSend={onQueueSend} canQueue={false} />);

    const button = screen.getByTestId('chat-queue-send');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onQueueSend).not.toHaveBeenCalled();
  });

  it('a full queue names the reason instead of going silently inert', () => {
    render(
      <InputActions
        {...baseProps}
        isStreaming
        onQueueSend={vi.fn()}
        canQueue={false}
        queuedCount={10}
        isQueueFull
      />,
    );

    const button = screen.getByTestId('chat-queue-send');
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/full/i);
    expect(screen.getByTestId('chat-queue-count')).toHaveTextContent('10');
  });
});

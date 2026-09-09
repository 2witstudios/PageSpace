import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputActions } from '../InputActions';

/**
 * B1, at the pixel that actually changes.
 *
 * The requirement that makes this worth a test is the NEGATIVE one: pressing Stop must not
 * render anything that says the generation ended. The reply keeps streaming until
 * `chat:stream_complete` says otherwise, so the button stays the Stop button and only its
 * label/affordance moves to "stopping".
 */
describe('InputActions — stopping affordance', () => {
  it('given a stream and no stop requested, should render the plain Stop button', () => {
    render(<InputActions isStreaming onSend={() => {}} onStop={() => {}} />);

    const stop = screen.getByTestId('chat-stop');
    expect(stop).toBeEnabled();
    expect(stop).toHaveAttribute('aria-label', 'Stop generating');
  });

  it('given a stop in flight, should show it as STOPPING and never flip back to Send', () => {
    render(<InputActions isStreaming isStopping onSend={() => {}} onStop={() => {}} />);

    const stop = screen.getByTestId('chat-stop');
    // Still the Stop button — a Send button here would mean "it ended", which is a lie while
    // the generation is very much still running.
    expect(stop).toBeInTheDocument();
    expect(screen.queryByTestId('chat-send')).not.toBeInTheDocument();
    expect(stop).toHaveAttribute('aria-label', 'Stopping');
    expect(stop).toHaveAttribute('data-stopping', 'true');
    // Feedback that only exists visually is not feedback for everyone.
    expect(stop).toHaveAttribute('aria-busy', 'true');
    expect(stop).toHaveAttribute('aria-disabled', 'true');
  });

  // The a11y half of the same requirement. A natively disabled button is removed from the focus
  // path, so a keyboard user who pressed Stop would lose focus to the body and never hear the
  // relabel — the announcement this state exists to make is exactly what `disabled` would
  // swallow. It stays focusable and the click is guarded instead.
  it('given a stop in flight, should stay focusable so the relabel is announced', () => {
    render(<InputActions isStreaming isStopping onSend={() => {}} onStop={() => {}} />);

    const stop = screen.getByTestId('chat-stop');
    expect(stop).not.toBeDisabled();

    stop.focus();
    expect(stop).toHaveFocus();
  });

  it('given a stop in flight, should not accept a second Stop click', () => {
    const onStop = vi.fn();
    render(<InputActions isStreaming isStopping onSend={() => {}} onStop={onStop} />);

    fireEvent.click(screen.getByTestId('chat-stop'));
    // Keyboard activation lands as a click too, and would bypass anything that only styled the
    // button as unavailable.
    fireEvent.keyDown(screen.getByTestId('chat-stop'), { key: 'Enter' });

    expect(onStop).not.toHaveBeenCalled();
  });
});

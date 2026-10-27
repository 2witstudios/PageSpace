import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageActionButtons } from '../MessageActionButtons';

/**
 * B2. A retry is a send, and a second one is a second regeneration — billed again. The button
 * took no in-flight state at all, so a double-click fired two.
 *
 * Edit and delete are deliberately NOT swept up: they are still legitimate while a regeneration
 * runs, which is why this is its own prop rather than a widening of `disabled`.
 */
describe('MessageActionButtons — retryDisabled', () => {
  const props = { onEdit: () => {}, onDelete: () => {} };

  it('given no retry in flight, should let Retry fire', () => {
    const onRetry = vi.fn();
    render(<MessageActionButtons {...props} onRetry={onRetry} />);

    fireEvent.click(screen.getByTestId('message-retry'));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('given a retry already in flight, should not fire a second one', () => {
    const onRetry = vi.fn();
    render(<MessageActionButtons {...props} onRetry={onRetry} retryDisabled />);

    fireEvent.click(screen.getByTestId('message-retry'));

    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByTestId('message-retry')).toBeDisabled();
  });

  it('given a retry in flight, should leave edit and delete usable', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <MessageActionButtons onEdit={onEdit} onDelete={onDelete} onRetry={() => {}} retryDisabled />,
    );

    fireEvent.click(screen.getByTitle('Edit message'));
    fireEvent.click(screen.getByTitle('Delete message'));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

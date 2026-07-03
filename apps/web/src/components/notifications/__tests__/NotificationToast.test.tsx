import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { LegacyNotification } from '@pagespace/lib/notifications/types';
import { NotificationToast } from '../NotificationToast';

type TestNotification = LegacyNotification & { title: string; message: string };

const FROZEN_DATE = new Date('2026-04-17T10:00:00Z');

function build(overrides: Partial<TestNotification> = {}): TestNotification {
  return {
    id: 'notif-1',
    userId: 'user-1',
    type: 'MENTION',
    title: 'You were mentioned',
    message: 'Jonathan mentioned you in "Roadmap"',
    isRead: false,
    createdAt: FROZEN_DATE,
    metadata: {},
    ...overrides,
  };
}

describe('NotificationToast', () => {
  it('renders title, message, and timestamp', () => {
    render(
      <NotificationToast notification={build()} onSelect={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByText('You were mentioned')).toBeInTheDocument();
    expect(screen.getByText('Jonathan mentioned you in "Roadmap"')).toBeInTheDocument();
  });

  it('sets data-notification-type for styling/testing hooks', () => {
    render(
      <NotificationToast notification={build({ type: 'TASK_ASSIGNED' })} onSelect={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByTestId('notification-toast')).toHaveAttribute(
      'data-notification-type',
      'TASK_ASSIGNED',
    );
  });

  it('renders triggered-by author when present', () => {
    render(
      <NotificationToast
        notification={build({ triggeredByUser: { id: 'u2', name: 'Jonathan Woodall', email: 'j@ex.com' } })}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('by Jonathan Woodall')).toBeInTheDocument();
  });

  it('omits triggered-by when no author', () => {
    render(
      <NotificationToast notification={build({ triggeredByUser: null })} onSelect={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.queryByText(/^by /)).not.toBeInTheDocument();
  });

  it('invokes onSelect when clicked', () => {
    const onSelect = vi.fn();
    render(<NotificationToast notification={build()} onSelect={onSelect} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByTestId('notification-toast'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('invokes onSelect on Enter keypress', () => {
    const onSelect = vi.fn();
    render(<NotificationToast notification={build()} onSelect={onSelect} onDismiss={vi.fn()} />);
    fireEvent.keyDown(screen.getByTestId('notification-toast'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('invokes onSelect on Space keypress', () => {
    const onSelect = vi.fn();
    render(<NotificationToast notification={build()} onSelect={onSelect} onDismiss={vi.fn()} />);
    fireEvent.keyDown(screen.getByTestId('notification-toast'), { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('invokes onDismiss when the dismiss button is clicked, without triggering onSelect', () => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    render(<NotificationToast notification={build()} onSelect={onSelect} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss notification/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not invoke onSelect when Enter is pressed on the nested dismiss button (bubbled event)', () => {
    const onSelect = vi.fn();
    render(<NotificationToast notification={build()} onSelect={onSelect} onDismiss={vi.fn()} />);
    const dismissButton = screen.getByRole('button', { name: /dismiss notification/i });
    fireEvent.keyDown(dismissButton, { key: 'Enter', bubbles: true });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

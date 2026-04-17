import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { LegacyNotification, NotificationType } from '@pagespace/lib/client-safe';
import { NotificationItem } from '../NotificationItem';
import { NOTIFICATION_ICONS } from '../notificationIcons';

type TestNotification = LegacyNotification & { title: string; message: string };

const FROZEN_DATE = new Date('2026-04-17T10:00:00Z');

function build(overrides: Partial<TestNotification> = {}): TestNotification {
  return {
    id: 'notif-1',
    userId: 'user-1',
    type: 'PAGE_SHARED',
    title: 'A page was shared with you',
    message: 'Jonathan shared "Roadmap" with you',
    isRead: false,
    createdAt: FROZEN_DATE,
    metadata: {},
    ...overrides,
  };
}

describe('NotificationItem', () => {
  describe('Rendering across every NotificationType', () => {
    const ALL_TYPES = Object.keys(NOTIFICATION_ICONS) as NotificationType[];

    it('covers every type in the NotificationType enum', () => {
      expect(ALL_TYPES.length).toBe(15);
    });

    it.each(ALL_TYPES)('renders type %s with title, message, and icon slot', (type) => {
      render(
        <NotificationItem
          notification={build({
            type,
            title: `Title for ${type}`,
            message: `Message for ${type}`,
            metadata: type === 'CONNECTION_REQUEST' ? { connectionId: 'c1', senderId: 's1' } : {},
          })}
        />,
      );

      const item = screen.getByTestId('notification-item');
      expect(item).toHaveAttribute('data-notification-type', type);
      expect(screen.getByText(`Title for ${type}`)).toBeInTheDocument();
      expect(screen.getByText(`Message for ${type}`)).toBeInTheDocument();
    });
  });

  describe('Unread vs read state', () => {
    it('marks the container as unread via data attribute', () => {
      render(<NotificationItem notification={build({ isRead: false })} />);
      expect(screen.getByTestId('notification-item')).toHaveAttribute('data-unread', 'true');
    });

    it('marks the container as read via data attribute', () => {
      render(<NotificationItem notification={build({ isRead: true })} />);
      expect(screen.getByTestId('notification-item')).toHaveAttribute('data-unread', 'false');
    });

    it('keeps the unread-dot slot in the DOM for both states so layout does not shift', () => {
      const { rerender } = render(<NotificationItem notification={build({ isRead: false })} />);
      expect(screen.getByTestId('notification-unread-dot')).toBeInTheDocument();

      rerender(<NotificationItem notification={build({ isRead: true })} />);
      expect(screen.getByTestId('notification-unread-dot')).toBeInTheDocument();
    });

    it('hides the unread dot visually when read', () => {
      render(<NotificationItem notification={build({ isRead: true })} />);
      expect(screen.getByTestId('notification-unread-dot')).toHaveClass('opacity-0');
    });

    it('shows the unread dot when unread', () => {
      render(<NotificationItem notification={build({ isRead: false })} />);
      expect(screen.getByTestId('notification-unread-dot')).toHaveClass('opacity-100');
    });
  });

  describe('Variants', () => {
    it('renders dropdown variant by default', () => {
      render(<NotificationItem notification={build()} />);
      expect(screen.getByTestId('notification-item')).toHaveAttribute('data-variant', 'dropdown');
    });

    it('renders page variant when requested', () => {
      render(<NotificationItem notification={build()} variant="page" />);
      expect(screen.getByTestId('notification-item')).toHaveAttribute('data-variant', 'page');
    });

    it('shows drive name in the meta row on the page variant', () => {
      render(
        <NotificationItem
          notification={build({
            drive: { id: 'd1', slug: 'pre-launch', name: 'Pre-Launch' },
          })}
          variant="page"
        />,
      );
      expect(screen.getByText('Pre-Launch')).toBeInTheDocument();
    });

    it('omits drive name on the dropdown variant', () => {
      render(
        <NotificationItem
          notification={build({
            drive: { id: 'd1', slug: 'pre-launch', name: 'Pre-Launch' },
          })}
          variant="dropdown"
        />,
      );
      expect(screen.queryByText('Pre-Launch')).not.toBeInTheDocument();
    });
  });

  describe('Meta row', () => {
    it('renders triggered-by author when present', () => {
      render(
        <NotificationItem
          notification={build({
            triggeredByUser: { id: 'u2', name: 'Jonathan Woodall', email: 'j@ex.com' },
          })}
        />,
      );
      expect(screen.getByText('by Jonathan Woodall')).toBeInTheDocument();
    });

    it('omits triggered-by separator when no author', () => {
      render(<NotificationItem notification={build({ triggeredByUser: null })} />);
      expect(screen.queryByText(/^by /)).not.toBeInTheDocument();
    });
  });

  describe('Interactions', () => {
    it('invokes onSelect when clicked', () => {
      const onSelect = vi.fn();
      render(<NotificationItem notification={build()} onSelect={onSelect} />);
      fireEvent.click(screen.getByTestId('notification-item'));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('invokes onSelect on Enter keypress for keyboard accessibility', () => {
      const onSelect = vi.fn();
      render(<NotificationItem notification={build()} onSelect={onSelect} />);
      fireEvent.keyDown(screen.getByTestId('notification-item'), { key: 'Enter' });
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('does not invoke onSelect when Enter is pressed on a nested button (bubbled event)', () => {
      const onSelect = vi.fn();
      const onDismiss = vi.fn();
      render(
        <NotificationItem
          notification={build()}
          onSelect={onSelect}
          onDismiss={onDismiss}
        />,
      );
      const dismissButton = screen.getByRole('button', { name: /dismiss notification/i });
      fireEvent.keyDown(dismissButton, { key: 'Enter', bubbles: true });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not invoke onSelect when Space is pressed on a nested Accept button', () => {
      const onSelect = vi.fn();
      const onAccept = vi.fn();
      const onDecline = vi.fn();
      render(
        <NotificationItem
          notification={build({
            type: 'CONNECTION_REQUEST',
            metadata: { connectionId: 'c1', senderId: 's1' },
          })}
          onSelect={onSelect}
          onAccept={onAccept}
          onDecline={onDecline}
        />,
      );
      const acceptButton = screen.getByRole('button', { name: 'Accept' });
      fireEvent.keyDown(acceptButton, { key: ' ', bubbles: true });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('renders dismiss button when onDismiss is provided and does not bubble to onSelect', () => {
      const onSelect = vi.fn();
      const onDismiss = vi.fn();
      render(
        <NotificationItem
          notification={build()}
          onSelect={onSelect}
          onDismiss={onDismiss}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /dismiss notification/i }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not render dismiss button when onDismiss is absent', () => {
      render(<NotificationItem notification={build()} />);
      expect(screen.queryByRole('button', { name: /dismiss notification/i })).not.toBeInTheDocument();
    });
  });

  describe('Connection request actions', () => {
    const connectionRequest = build({
      type: 'CONNECTION_REQUEST',
      title: 'Connection request',
      message: 'Jane wants to connect',
      metadata: { connectionId: 'conn-42', senderId: 'jane-1' },
    });

    it('renders Accept and Decline buttons when handlers are provided', () => {
      render(
        <NotificationItem
          notification={connectionRequest}
          onAccept={vi.fn()}
          onDecline={vi.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    });

    it('does not toggle onSelect when Accept or Decline are clicked', () => {
      const onSelect = vi.fn();
      const onAccept = vi.fn();
      const onDecline = vi.fn();
      render(
        <NotificationItem
          notification={connectionRequest}
          onSelect={onSelect}
          onAccept={onAccept}
          onDecline={onDecline}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      expect(onAccept).toHaveBeenCalledTimes(1);
      expect(onDecline).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('omits Accept/Decline when Accept handler missing', () => {
      render(
        <NotificationItem notification={connectionRequest} onDecline={vi.fn()} />,
      );
      expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
    });
  });

  describe('Theme tokens only', () => {
    it('uses semantic color tokens rather than raw palette classes', () => {
      render(<NotificationItem notification={build({ isRead: false })} />);
      const item = screen.getByTestId('notification-item');
      const className = item.className;
      const forbidden = /\b(?:text|bg|border)-(?:red|blue|green|amber|yellow|purple|indigo|gray|slate|zinc|neutral|stone|orange|pink|rose|sky|teal|emerald|lime|cyan|violet|fuchsia)-\d{2,3}\b/;
      expect(className).not.toMatch(forbidden);
    });
  });
});

/**
 * The one thing this module's Retry button must never do: hand `onAction`
 * anything. `onClick` always receives the click's MouseEvent, and a caller
 * whose `onAction` is (or wraps) an SWR `mutate` reads that event as
 * replacement cache data instead of "revalidate now" — silently corrupting the
 * caller's data instead of refetching it. Every consumer of `SidebarNotice`
 * depends on this guarantee holding here, once, rather than each caller having
 * to remember to wrap its own `onAction`.
 *
 * (Travelled with the component from `machine/tabs/tab-states.tsx`; its
 * `PaneNotice` twin still lives beside that module.)
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarLoading, SidebarNotice } from '../sidebar-states';

describe('SidebarNotice', () => {
  test('calls onAction with zero arguments, not the click event', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<SidebarNotice title="Failed" actionLabel="Retry" onAction={onAction} />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith();
  });

  test('renders no action when there is nothing the reader can do about it', () => {
    render(<SidebarNotice title="No agents in this drive yet" />);
    expect(screen.getByText('No agents in this drive yet')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('SidebarLoading', () => {
  test("shows the caller's own message", () => {
    render(<SidebarLoading message="Loading agents…" />);
    expect(screen.getByText('Loading agents…')).toBeInTheDocument();
  });
});

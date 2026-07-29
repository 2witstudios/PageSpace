/**
 * The one thing this module's Retry button must never do: hand `onAction`
 * anything. `onClick` always receives the click's MouseEvent, and a caller
 * whose `onAction` is (or wraps) an SWR `mutate` reads that event as
 * replacement cache data instead of "revalidate now" — silently corrupting
 * the caller's data instead of refetching it. Every consumer of `PaneNotice`
 * depends on this guarantee holding here, once, rather than each caller having
 * to remember to wrap its own `onAction`.
 *
 * `SidebarNotice`'s half of this guarantee moved with the component, to
 * `left-sidebar/__tests__/sidebar-states.test.tsx`.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaneNotice } from './tab-states';

describe('PaneNotice', () => {
  test('calls onAction with zero arguments, not the click event', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<PaneNotice title="Failed" actionLabel="Retry" onAction={onAction} />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith();
  });
});

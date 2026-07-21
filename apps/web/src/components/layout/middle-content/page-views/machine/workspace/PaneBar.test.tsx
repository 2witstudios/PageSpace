/**
 * PaneBar — the universal pane title bar (pane-chrome redesign, variant B).
 * Pure presentational: identity left, actions right, bar tint AS the focus
 * state. These tests pin the contract every pane surface (PTY, picker, chat)
 * relies on, without any store or hook in sight.
 */
import { describe, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';
import PaneBar, { PaneSplitCloseActions, PaneSessionIdentity } from './PaneBar';

describe('PaneBar', () => {
  test('renders identity and actions, and marks the active state on the bar itself', () => {
    render(
      <PaneBar isActive identity={<span>shell-a1</span>} actions={<button type="button">act</button>} />,
    );

    const bar = screen.getByTestId('pane-bar');
    assert({
      given: 'an active pane\'s bar with identity and actions',
      should: 'render both and carry data-active — the bar tint IS the focus state, replacing the old 2px accent line',
      actual: {
        active: bar.getAttribute('data-active'),
        identity: screen.queryByText('shell-a1') !== null,
        action: screen.queryByRole('button', { name: 'act' }) !== null,
      },
      expected: { active: 'true', identity: true, action: true },
    });
  });

  test('an inactive bar carries no active marker', () => {
    render(<PaneBar isActive={false} identity={<span>shell-a1</span>} />);

    assert({
      given: 'an inactive pane\'s bar',
      should: 'carry no data-active — inactive is the unmarked default, not a second style',
      actual: screen.getByTestId('pane-bar').getAttribute('data-active'),
      expected: null,
    });
  });

  test('actions sit in a reveal container that never fully hides', () => {
    render(<PaneBar isActive={false} identity={<span>x</span>} actions={<button type="button">act</button>} />);

    const container = screen.getByRole('button', { name: 'act' }).parentElement as HTMLElement;
    assert({
      given: 'the actions container',
      should:
        'dim rather than hide (opacity, not display) — controls stay clickable on every pointer type without the coarse-pointer escape hatch the floating chip needed',
      actual: {
        dimmed: container.className.includes('opacity-60'),
        hidden: container.className.includes('opacity-0'),
      },
      expected: { dimmed: true, hidden: false },
    });
  });
});

describe('PaneSplitCloseActions', () => {
  test('renders split and close controls wired to their handlers', async () => {
    const onSplitRight = vi.fn();
    const onSplitDown = vi.fn();
    const onClose = vi.fn();
    render(
      <PaneSplitCloseActions canSplit canClose onSplitRight={onSplitRight} onSplitDown={onSplitDown} onClose={onClose} />,
    );

    await userEvent.click(screen.getByTitle('Split right'));
    await userEvent.click(screen.getByTitle('Split down'));
    await userEvent.click(screen.getByTitle('Close pane'));

    assert({
      given: 'all three pane controls clicked',
      should: 'call each handler exactly once',
      actual: {
        splitRight: onSplitRight.mock.calls.length,
        splitDown: onSplitDown.mock.calls.length,
        close: onClose.mock.calls.length,
      },
      expected: { splitRight: 1, splitDown: 1, close: 1 },
    });
  });

  test('canSplit=false renders close only — a phone cannot hold a split grid', () => {
    render(
      <PaneSplitCloseActions canSplit={false} canClose onSplitRight={vi.fn()} onSplitDown={vi.fn()} onClose={vi.fn()} />,
    );

    assert({
      given: 'a pane that cannot split (narrow viewport)',
      should: 'offer close but neither split control',
      actual: {
        close: screen.queryByTitle('Close pane') !== null,
        splitRight: screen.queryByTitle('Split right'),
        splitDown: screen.queryByTitle('Split down'),
      },
      expected: { close: true, splitRight: null, splitDown: null },
    });
  });

  test('clicks do not bubble into the pane\'s own click handler', async () => {
    const onPaneClick = vi.fn();
    const onClose = vi.fn();
    render(
      <div onClick={onPaneClick}>
        <PaneSplitCloseActions canSplit={false} canClose onSplitRight={vi.fn()} onSplitDown={vi.fn()} onClose={onClose} />
      </div>,
    );

    await userEvent.click(screen.getByTitle('Close pane'));

    assert({
      given: 'a close click inside a pane whose root selects-on-click',
      should: 'stop propagation — closing a pane must not first re-select it (the old floating chip had the same guard)',
      actual: { closed: onClose.mock.calls.length, paneClicked: onPaneClick.mock.calls.length },
      expected: { closed: 1, paneClicked: 0 },
    });
  });
});

describe('PaneSessionIdentity', () => {
  test('shows the session name and its checkout scope', () => {
    render(<PaneSessionIdentity name="shell-b2c3d4" scopeLabel="app / main" />);

    assert({
      given: 'a bound pane\'s identity',
      should: 'name the session and the checkout it runs in — the sidebar/pane relationship becomes legible per pane',
      actual: {
        name: screen.queryByText('shell-b2c3d4') !== null,
        scope: screen.queryByText('app / main') !== null,
      },
      expected: { name: true, scope: true },
    });
  });

  test('omits the scope chip when no label is given', () => {
    render(<PaneSessionIdentity name="shell-b2c3d4" />);

    assert({
      given: 'an identity without a scope label',
      should: 'render the name alone, no empty chip',
      actual: screen.getByText('shell-b2c3d4').parentElement?.childElementCount,
      expected: 2, // dot + name
    });
  });
});

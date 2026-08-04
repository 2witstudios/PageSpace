/**
 * The empty pane's choices. The assertion that matters is that a conversation
 * is on the menu at all — a picker offering only shells is what tabs degraded
 * into, and it is why splitting had nothing worth splitting into.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PanePicker from '../PanePicker';

const agents = [
  { id: 'agent-1', title: 'Research Agent' },
  { id: 'agent-2', title: 'Refactor Agent' },
];

describe('PanePicker', () => {
  it('should offer a shell AND agent conversations, not just a shell', () => {
    render(<PanePicker agents={agents} canRunSandbox onPickAgent={vi.fn()} onPickShell={vi.fn()} />);
    expect(screen.getByTestId('pick-shell')).toBeInTheDocument();
    expect(screen.getByTestId('pick-agent-agent-1')).toBeInTheDocument();
    expect(screen.getByTestId('pick-agent-agent-2')).toBeInTheDocument();
  });

  it('should let the pane choose WHICH agent — a grid is not restricted to one', () => {
    const onPickAgent = vi.fn();
    render(<PanePicker agents={agents} canRunSandbox onPickAgent={onPickAgent} onPickShell={vi.fn()} />);
    expect(screen.getByText('Research Agent')).toBeInTheDocument();
    expect(screen.getByText('Refactor Agent')).toBeInTheDocument();
  });

  it('should report the picked agent by id', async () => {
    const onPickAgent = vi.fn();
    render(<PanePicker agents={agents} canRunSandbox onPickAgent={onPickAgent} onPickShell={vi.fn()} />);
    await userEvent.click(screen.getByTestId('pick-agent-agent-2'));
    expect(onPickAgent).toHaveBeenCalledWith('agent-2');
  });

  it('should offer the global assistant as a null agent page — when enabled', async () => {
    // A global-assistant conversation has no agent page; a null pick is how the
    // session model already expresses that.
    const onPickAgent = vi.fn();
    render(
      <PanePicker agents={agents} canRunSandbox canPickAssistant onPickAgent={onPickAgent} onPickShell={vi.fn()} />,
    );
    await userEvent.click(screen.getByTestId('pick-global-assistant'));
    expect(onPickAgent).toHaveBeenCalledWith(null);
  });

  it('should NOT offer the assistant by default — a pick with no renderer is a dead menu item', () => {
    // The chat surface resolves identity from an agent page today; until the
    // assistant identity path lands, offering the choice would resolve to
    // nothing. Off by default, flipped when that path exists.
    render(<PanePicker agents={agents} canRunSandbox onPickAgent={vi.fn()} onPickShell={vi.fn()} />);
    expect(screen.queryByTestId('pick-global-assistant')).not.toBeInTheDocument();
  });

  it('should report a shell pick', async () => {
    const onPickShell = vi.fn();
    render(<PanePicker agents={agents} canRunSandbox onPickAgent={vi.fn()} onPickShell={onPickShell} />);
    await userEvent.click(screen.getByTestId('pick-shell'));
    expect(onPickShell).toHaveBeenCalledTimes(1);
  });

  it('should focus its first choice when a split just made this pane', () => {
    // The old grid set pendingPickerPaneId on a split so the user landed in the
    // picker — "the user asked for a new agent, not for a blank rectangle to go
    // find a control in."
    render(<PanePicker agents={agents} canRunSandbox autoFocus onPickAgent={vi.fn()} onPickShell={vi.fn()} />);
    expect(screen.getByTestId('pick-shell')).toHaveFocus();
  });

  it('should not steal focus when it was not the pane just split', () => {
    render(<PanePicker agents={agents} canRunSandbox onPickAgent={vi.fn()} onPickShell={vi.fn()} />);
    expect(screen.getByTestId('pick-shell')).not.toHaveFocus();
  });

  it('given agents still loading, should say so rather than claim the drive has none', () => {
    render(<PanePicker agents={[]} canRunSandbox isLoading onPickAgent={vi.fn()} onPickShell={vi.fn()} />);
    expect(screen.getByTestId('pane-picker-loading')).toBeInTheDocument();
  });

  it('given a drive with no agents, should still offer a shell (and the assistant when enabled)', () => {
    render(<PanePicker agents={[]} canRunSandbox canPickAssistant onPickAgent={vi.fn()} onPickShell={vi.fn()} />);
    expect(screen.queryByTestId('pane-picker-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('pick-shell')).toBeInTheDocument();
    expect(screen.getByTestId('pick-global-assistant')).toBeInTheDocument();
  });

  describe('reattaching an existing shell (issue #2263, finding 3)', () => {
    const shells = [
      { shellId: 'shell-1', name: 'build' },
      { shellId: 'shell-2', name: 'server' },
    ];

    it('offers each existing shell as a reattach choice', () => {
      render(
        <PanePicker
          agents={agents}
          canRunSandbox
          existingShells={shells}
          onPickAgent={vi.fn()}
          onPickShell={vi.fn()}
        />,
      );
      expect(screen.getByTestId('reattach-shell-shell-1')).toBeInTheDocument();
      expect(screen.getByText('build')).toBeInTheDocument();
      expect(screen.getByTestId('reattach-shell-shell-2')).toBeInTheDocument();
      expect(screen.getByText('server')).toBeInTheDocument();
    });

    it('reports the reattached shell by id and name', async () => {
      const onReattachShell = vi.fn();
      render(
        <PanePicker
          agents={agents}
          canRunSandbox
          existingShells={shells}
          onPickAgent={vi.fn()}
          onPickShell={vi.fn()}
          onReattachShell={onReattachShell}
        />,
      );
      await userEvent.click(screen.getByTestId('reattach-shell-shell-2'));
      expect(onReattachShell).toHaveBeenCalledWith('shell-2', 'server');
    });

    it('renders no reattach section when there is nothing to reattach', () => {
      render(<PanePicker agents={agents} canRunSandbox existingShells={[]} onPickAgent={vi.fn()} onPickShell={vi.fn()} />);
      expect(screen.queryByText(/reattach/i)).not.toBeInTheDocument();
    });

    it('omits the section entirely when the prop is not passed — sidebar callers unaffected', () => {
      render(<PanePicker agents={agents} canRunSandbox onPickAgent={vi.fn()} onPickShell={vi.fn()} />);
      expect(screen.queryByText(/reattach/i)).not.toBeInTheDocument();
    });
  });

  describe('sandbox tier ineligibility (free-tier payer)', () => {
    it('disables the Shell button and does not fire onPickShell when clicked', async () => {
      const onPickShell = vi.fn();
      render(<PanePicker agents={agents} canRunSandbox={false} onPickAgent={vi.fn()} onPickShell={onPickShell} />);
      const shellButton = screen.getByTestId('pick-shell');
      expect(shellButton).toBeDisabled();
      await userEvent.click(shellButton, { pointerEventsCheck: 0 });
      expect(onPickShell).not.toHaveBeenCalled();
    });

    it('shows an upgrade tooltip on the disabled Shell button', async () => {
      render(<PanePicker agents={agents} canRunSandbox={false} onPickAgent={vi.fn()} onPickShell={vi.fn()} />);
      const trigger = screen.getByTestId('pick-shell').closest('[tabindex]');
      expect(trigger).not.toBeNull();
      await userEvent.hover(trigger!);
      // Radix renders the tooltip's text twice (a visible node plus a
      // visually-hidden `role="tooltip"` copy for screen readers) — assert
      // on the accessible one specifically rather than a plain text query,
      // which would fail on the duplicate match.
      expect(await screen.findByRole('tooltip', { name: /upgrade to pro/i })).toBeInTheDocument();
    });

    it('does not steal autofocus onto a disabled Shell button', () => {
      render(<PanePicker agents={agents} canRunSandbox={false} autoFocus onPickAgent={vi.fn()} onPickShell={vi.fn()} />);
      expect(screen.getByTestId('pick-shell')).not.toHaveFocus();
    });

    it('disables existing-shell reattach buttons too', async () => {
      const onReattachShell = vi.fn();
      render(
        <PanePicker
          agents={agents}
          canRunSandbox={false}
          existingShells={[{ shellId: 'shell-1', name: 'build' }]}
          onPickAgent={vi.fn()}
          onPickShell={vi.fn()}
          onReattachShell={onReattachShell}
        />,
      );
      const reattachButton = screen.getByTestId('reattach-shell-shell-1');
      expect(reattachButton).toBeDisabled();
      await userEvent.click(reattachButton, { pointerEventsCheck: 0 });
      expect(onReattachShell).not.toHaveBeenCalled();
    });

    it('leaves agent conversation picks and the global assistant unaffected — only the sandbox is gated', async () => {
      const onPickAgent = vi.fn();
      render(
        <PanePicker
          agents={agents}
          canRunSandbox={false}
          canPickAssistant
          onPickAgent={onPickAgent}
          onPickShell={vi.fn()}
        />,
      );
      expect(screen.getByTestId('pick-agent-agent-1')).not.toBeDisabled();
      expect(screen.getByTestId('pick-global-assistant')).not.toBeDisabled();
      await userEvent.click(screen.getByTestId('pick-agent-agent-1'));
      expect(onPickAgent).toHaveBeenCalledWith('agent-1');
    });
  });
});

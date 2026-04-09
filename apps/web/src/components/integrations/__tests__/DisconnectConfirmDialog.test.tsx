import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DisconnectConfirmDialog } from '../DisconnectConfirmDialog';

describe('DisconnectConfirmDialog', () => {
  const mockOnOpenChange = vi.fn();
  const mockOnConfirm = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render dialog when open', () => {
    render(
      <DisconnectConfirmDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        connectionName="Google Calendar"
        onConfirm={mockOnConfirm}
      />
    );

    expect(screen.getByText('Disconnect Google Calendar?')).toBeInTheDocument();
    expect(screen.getByText(/This will remove the connection and revoke access/)).toBeInTheDocument();
  });

  it('should not render dialog when closed', () => {
    render(
      <DisconnectConfirmDialog
        open={false}
        onOpenChange={mockOnOpenChange}
        connectionName="Google Calendar"
        onConfirm={mockOnConfirm}
      />
    );

    expect(screen.queryByText('Disconnect Google Calendar?')).not.toBeInTheDocument();
  });

  it('should call onConfirm when disconnect clicked', async () => {
    const user = userEvent.setup();

    render(
      <DisconnectConfirmDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        connectionName="Google Calendar"
        onConfirm={mockOnConfirm}
      />
    );

    const disconnectButton = screen.getByRole('button', { name: /Disconnect/i });
    await user.click(disconnectButton);

    expect(mockOnConfirm).toHaveBeenCalledOnce();
  });

  it('should show agent warning when affectedAgentCount > 0', () => {
    render(
      <DisconnectConfirmDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        connectionName="GitHub"
        onConfirm={mockOnConfirm}
        affectedAgentCount={3}
      />
    );

    expect(screen.getByText(/3 AI agents are using this integration/)).toBeInTheDocument();
  });

  it('should show singular agent warning for 1 agent', () => {
    render(
      <DisconnectConfirmDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        connectionName="GitHub"
        onConfirm={mockOnConfirm}
        affectedAgentCount={1}
      />
    );

    expect(screen.getByText(/1 AI agent is using this integration/)).toBeInTheDocument();
  });

  it('should not show agent warning when affectedAgentCount is 0', () => {
    render(
      <DisconnectConfirmDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        connectionName="GitHub"
        onConfirm={mockOnConfirm}
        affectedAgentCount={0}
      />
    );

    expect(screen.queryByText(/AI agent/)).not.toBeInTheDocument();
  });

  it('should not show agent warning when affectedAgentCount is undefined', () => {
    render(
      <DisconnectConfirmDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        connectionName="GitHub"
        onConfirm={mockOnConfirm}
      />
    );

    expect(screen.queryByText(/AI agent/)).not.toBeInTheDocument();
  });

  it('should have cancel button', async () => {
    const user = userEvent.setup();

    render(
      <DisconnectConfirmDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        connectionName="Slack"
        onConfirm={mockOnConfirm}
      />
    );

    const cancelButton = screen.getByRole('button', { name: /Cancel/i });
    expect(cancelButton).toBeInTheDocument();
    await user.click(cancelButton);
  });

  it('should show loading state and disable disconnect while count loads', () => {
    render(
      <DisconnectConfirmDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        connectionName="GitHub"
        onConfirm={mockOnConfirm}
        isLoadingCount={true}
      />
    );

    expect(screen.getByText('Checking agent usage...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeDisabled();
  });

  it('should not show loading or warning when count loaded with zero', () => {
    render(
      <DisconnectConfirmDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        connectionName="GitHub"
        onConfirm={mockOnConfirm}
        affectedAgentCount={0}
        isLoadingCount={false}
      />
    );

    expect(screen.queryByText('Checking agent usage...')).not.toBeInTheDocument();
    expect(screen.queryByText(/AI agent/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disconnect/i })).not.toBeDisabled();
  });
});

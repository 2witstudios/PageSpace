import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DriveOwnershipDialog } from '../DriveOwnershipDialog';

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock auth-fetch
vi.mock('@/lib/auth-fetch', () => ({
  post: vi.fn(),
}));

import { toast } from 'sonner';
import { post } from '@/lib/auth-fetch';

describe('DriveOwnershipDialog', () => {
  const mockOnClose = vi.fn();
  const mockOnAllDrivesHandled = vi.fn();

  const mockMultiMemberDrives = [
    {
      id: 'drive_1',
      name: 'Team Drive 1',
      memberCount: 5,
      admins: [
        { id: 'admin_1', name: 'Admin One', email: 'admin1@example.com' },
        { id: 'admin_2', name: 'Admin Two', email: 'admin2@example.com' },
      ],
    },
    {
      id: 'drive_2',
      name: 'Team Drive 2',
      memberCount: 3,
      admins: [
        { id: 'admin_3', name: 'Admin Three', email: 'admin3@example.com' },
      ],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(post).mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should render dialog when open', () => {
    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    expect(screen.getByText('Handle Drive Ownership')).toBeInTheDocument();
    expect(screen.getByText(/Before deleting your account/)).toBeInTheDocument();
  });

  it('should not render dialog when closed', () => {
    render(
      <DriveOwnershipDialog
        isOpen={false}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    expect(screen.queryByText('Handle Drive Ownership')).not.toBeInTheDocument();
  });

  it('should render list of multi-member drives', () => {
    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    expect(screen.getByText('Team Drive 1')).toBeInTheDocument();
    expect(screen.getByText('Team Drive 2')).toBeInTheDocument();
    expect(screen.getByText('5 members')).toBeInTheDocument();
    expect(screen.getByText('3 members')).toBeInTheDocument();
  });

  it('should show admin dropdown for each drive', () => {
    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    const dropdowns = screen.getAllByText('Select new owner (admin)');
    expect(dropdowns).toHaveLength(2);
  });

  it('should disable transfer button until admin selected', async () => {
    const user = userEvent.setup();

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    const transferButtons = screen.getAllByRole('button', { name: /Transfer/i });
    expect(transferButtons[0]).toBeDisabled();
  });

  it('should show "No admins available" message when no admins', () => {
    const drivesWithNoAdmins = [
      {
        id: 'drive_no_admin',
        name: 'No Admin Drive',
        memberCount: 3,
        admins: [],
      },
    ];

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={drivesWithNoAdmins}
      />
    );

    expect(screen.getByText(/No admins available to transfer to/)).toBeInTheDocument();
    expect(screen.getByText(/You must delete this drive/)).toBeInTheDocument();
  });

  it('should call API with correct params on transfer', async () => {
    const user = userEvent.setup();

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    // Select admin from dropdown (this is simplified - actual implementation may vary)
    const dropdowns = screen.getAllByText('Select new owner (admin)');
    await user.click(dropdowns[0]);

    const adminOption = screen.getByText('Admin One (admin1@example.com)');
    await user.click(adminOption);

    // Click transfer button
    const transferButtons = screen.getAllByRole('button', { name: /Transfer/i });
    await user.click(transferButtons[0]);

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/api/account/handle-drive', {
        driveId: 'drive_1',
        action: 'transfer',
        newOwnerId: 'admin_1',
      });
    });
  });

  it('should call API with correct params on delete', async () => {
    const user = userEvent.setup();

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    const deleteButtons = screen.getAllByRole('button', { name: /Delete Drive/i });
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/api/account/handle-drive', {
        driveId: 'drive_1',
        action: 'delete',
      });
    });
  });

  it('should remove drive from list after successful transfer', async () => {
    const user = userEvent.setup();

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    // Select admin
    const dropdowns = screen.getAllByText('Select new owner (admin)');
    await user.click(dropdowns[0]);
    const adminOption = screen.getByText('Admin One (admin1@example.com)');
    await user.click(adminOption);

    // Transfer
    const transferButtons = screen.getAllByRole('button', { name: /Transfer/i });
    await user.click(transferButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText('Team Drive 1')).not.toBeInTheDocument();
    });

    expect(toast.success).toHaveBeenCalledWith('Transferred ownership of "Team Drive 1"');
  });

  it('should remove drive from list after successful delete', async () => {
    const user = userEvent.setup();

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    const deleteButtons = screen.getAllByRole('button', { name: /Delete Drive/i });
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText('Team Drive 1')).not.toBeInTheDocument();
    });

    expect(toast.success).toHaveBeenCalledWith('Deleted drive "Team Drive 1"');
  });

  it('should call onAllDrivesHandled when last drive handled', async () => {
    const user = userEvent.setup();

    const singleDrive = [mockMultiMemberDrives[0]];

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={singleDrive}
      />
    );

    const deleteButton = screen.getByRole('button', { name: /Delete Drive/i });
    await user.click(deleteButton);

    await waitFor(() => {
      expect(mockOnAllDrivesHandled).toHaveBeenCalled();
    });
  });

  it('should show loading state during processing', async () => {
    const user = userEvent.setup();

    vi.mocked(post).mockImplementation(() => new Promise(() => {})); // Never resolves

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    const deleteButtons = screen.getAllByRole('button', { name: /Delete Drive/i });
    await user.click(deleteButtons[0]);

    // Should show loading spinner
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '' })).toBeInTheDocument(); // Loader has no name
    });
  });

  it('should prevent closing during processing', async () => {
    const user = userEvent.setup();

    vi.mocked(post).mockImplementation(() => new Promise(() => {})); // Never resolves

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    const deleteButtons = screen.getAllByRole('button', { name: /Delete Drive/i });
    await user.click(deleteButtons[0]);

    // Try to cancel
    const cancelButton = screen.getByRole('button', { name: /Cancel/i });
    expect(cancelButton).toBeDisabled();
  });

  it('should display error toast on API failure', async () => {
    const user = userEvent.setup();

    vi.mocked(post).mockRejectedValue(new Error('Network error'));

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    const deleteButtons = screen.getAllByRole('button', { name: /Delete Drive/i });
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Network error');
    });

    // Drive should still be in list after failure
    expect(screen.getByText('Team Drive 1')).toBeInTheDocument();
  });

  it('should handle multiple drives correctly', () => {
    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    expect(screen.getByText(/You own 2 drives? with other members/)).toBeInTheDocument();
  });

  it('should use singular form for 1 drive', () => {
    const singleDrive = [mockMultiMemberDrives[0]];

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={singleDrive}
      />
    );

    expect(screen.getByText(/You own 1 drive with other members/)).toBeInTheDocument();
  });

  it('should show transfer button for drive with admins', () => {
    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={[mockMultiMemberDrives[0]]}
      />
    );

    expect(screen.getByRole('button', { name: /Transfer/i })).toBeInTheDocument();
  });

  it('should allow closing when not processing', async () => {
    const user = userEvent.setup();

    render(
      <DriveOwnershipDialog
        isOpen={true}
        onClose={mockOnClose}
        onAllDrivesHandled={mockOnAllDrivesHandled}
        multiMemberDrives={mockMultiMemberDrives}
      />
    );

    const cancelButton = screen.getByRole('button', { name: /Cancel/i });
    await user.click(cancelButton);

    expect(mockOnClose).toHaveBeenCalled();
  });
});

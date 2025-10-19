import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteAccountDialog } from '../DeleteAccountDialog';

describe('DeleteAccountDialog', () => {
  const mockOnClose = vi.fn();
  const mockOnConfirm = vi.fn();
  const userEmail = 'test@example.com';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render dialog when open', () => {
    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    expect(screen.getByText('Delete Your Account?')).toBeInTheDocument();
    expect(screen.getByText(/This action is permanent and cannot be undone/)).toBeInTheDocument();
  });

  it('should not render dialog when closed', () => {
    render(
      <DeleteAccountDialog
        isOpen={false}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    expect(screen.queryByText('Delete Your Account?')).not.toBeInTheDocument();
  });

  it('should disable delete button until email matches', async () => {
    const user = userEvent.setup();

    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    const deleteButton = screen.getByRole('button', { name: /Delete Account Permanently/i });
    const emailInput = screen.getByPlaceholderText('Enter your email address');

    // Initially disabled
    expect(deleteButton).toBeDisabled();

    // Type incorrect email
    await user.type(emailInput, 'wrong@example.com');
    expect(deleteButton).toBeDisabled();

    // Clear and type correct email
    await user.clear(emailInput);
    await user.type(emailInput, userEmail);
    expect(deleteButton).not.toBeDisabled();
  });

  it('should accept email with different case', async () => {
    const user = userEvent.setup();

    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    const deleteButton = screen.getByRole('button', { name: /Delete Account Permanently/i });
    const emailInput = screen.getByPlaceholderText('Enter your email address');

    await user.type(emailInput, 'TEST@EXAMPLE.COM');
    expect(deleteButton).not.toBeDisabled();
  });

  it('should call onConfirm with email when delete button clicked', async () => {
    const user = userEvent.setup();

    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    const deleteButton = screen.getByRole('button', { name: /Delete Account Permanently/i });
    const emailInput = screen.getByPlaceholderText('Enter your email address');

    await user.type(emailInput, userEmail);
    await user.click(deleteButton);

    expect(mockOnConfirm).toHaveBeenCalledWith(userEmail);
  });

  it('should show loading state while deleting', () => {
    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={true}
        soloDrivesCount={0}
      />
    );

    const deleteButton = screen.getByRole('button', { name: /Deleting Account/i });
    const cancelButton = screen.getByRole('button', { name: /Cancel/i });

    expect(deleteButton).toBeDisabled();
    expect(cancelButton).toBeDisabled();
    expect(screen.getByPlaceholderText('Enter your email address')).toBeDisabled();
  });

  it('should call onClose when cancel button clicked', async () => {
    const user = userEvent.setup();

    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    const cancelButton = screen.getByRole('button', { name: /Cancel/i });
    await user.click(cancelButton);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('should not allow closing while deleting', async () => {
    const user = userEvent.setup();

    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={true}
        soloDrivesCount={0}
      />
    );

    const cancelButton = screen.getByRole('button', { name: /Cancel/i });
    await user.click(cancelButton);

    // Should not call onClose while deleting
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('should show solo drives count in warning', () => {
    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={3}
      />
    );

    expect(screen.getByText(/3 drives? where you're the only member will be automatically deleted/i)).toBeInTheDocument();
  });

  it('should use singular form for 1 solo drive', () => {
    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={1}
      />
    );

    expect(screen.getByText(/1 drive where you're the only member will be automatically deleted/i)).toBeInTheDocument();
  });

  it('should not show solo drives message when count is 0', () => {
    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    expect(screen.queryByText(/drive.*will be automatically deleted/i)).not.toBeInTheDocument();
  });

  it('should display user email in confirmation label', () => {
    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    expect(screen.getByText(userEmail, { exact: false })).toBeInTheDocument();
  });

  it('should clear email input on close', async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    const emailInput = screen.getByPlaceholderText('Enter your email address');
    await user.type(emailInput, 'test@example.com');

    // Close the dialog
    rerender(
      <DeleteAccountDialog
        isOpen={false}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    // Reopen the dialog
    rerender(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    // Input should be cleared
    const newEmailInput = screen.getByPlaceholderText('Enter your email address');
    expect(newEmailInput).toHaveValue('');
  });

  it('should display all warning messages', () => {
    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={2}
      />
    );

    expect(screen.getByText(/All your data, messages, and content will be permanently lost/i)).toBeInTheDocument();
    expect(screen.getByText(/This action cannot be reversed/i)).toBeInTheDocument();
  });

  it('should trim whitespace from email input', async () => {
    const user = userEvent.setup();

    render(
      <DeleteAccountDialog
        isOpen={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
        userEmail={userEmail}
        isDeleting={false}
        soloDrivesCount={0}
      />
    );

    const deleteButton = screen.getByRole('button', { name: /Delete Account Permanently/i });
    const emailInput = screen.getByPlaceholderText('Enter your email address');

    // Type email with spaces
    await user.type(emailInput, `  ${userEmail}  `);

    // Button should be enabled (trimming happens in validation)
    expect(deleteButton).not.toBeDisabled();

    await user.click(deleteButton);
    expect(mockOnConfirm).toHaveBeenCalledWith(`  ${userEmail}  `);
  });
});

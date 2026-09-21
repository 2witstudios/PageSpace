import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

type P = { children?: React.ReactNode; open?: boolean; onSelect?: () => void; onClick?: () => void };
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: P) => <div>{children}</div>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: ({ children, onSelect, onClick }: P) => <button type="button" onClick={onSelect ?? onClick}>{children}</button>,
  };
});
vi.mock('@/components/ui/dialog', () => {
  const Pass = ({ children }: P) => <div>{children}</div>;
  return { Dialog: ({ open, children }: P) => (open ? <div>{children}</div> : null), DialogContent: Pass, DialogHeader: Pass, DialogTitle: Pass, DialogDescription: Pass, DialogFooter: Pass };
});
vi.mock('@/components/ui/alert-dialog', () => {
  const Pass = ({ children }: P) => <div>{children}</div>;
  return {
    AlertDialog: ({ open, children }: P) => (open ? <div>{children}</div> : null),
    AlertDialogContent: Pass, AlertDialogHeader: Pass, AlertDialogTitle: Pass, AlertDialogDescription: Pass, AlertDialogFooter: Pass,
    AlertDialogCancel: ({ children }: P) => <button type="button">{children}</button>,
  };
});
const { post, toast } = vi.hoisted(() => ({ post: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/auth-fetch', () => ({ post }));
vi.mock('sonner', () => ({ toast }));

import { UserSafetyMenu } from '../UserSafetyMenu';

describe('UserSafetyMenu', () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({});
  });

  it('given a user reports someone in a conversation, should send the report with the reason and conversation', async () => {
    render(<UserSafetyMenu userId="user_abuser" displayName="Sam" conversationId="conv_1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Report Sam' }));
    fireEvent.change(screen.getByLabelText(/what happened/i), { target: { value: 'Harassing messages' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/user-reports', {
        targetUserId: 'user_abuser',
        conversationId: 'conv_1',
        reason: 'Harassing messages',
      }),
    );
  });

  it('given a user blocks someone and confirms, should record the block and tell the caller', async () => {
    const onBlocked = vi.fn();
    render(<UserSafetyMenu userId="user_abuser" displayName="Sam" onBlocked={onBlocked} />);
    fireEvent.click(screen.getByRole('button', { name: 'Block Sam' }));
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/users/user_abuser/block'));
    await waitFor(() => expect(onBlocked).toHaveBeenCalled());
  });
});

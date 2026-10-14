// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleEditor } from './RoleEditor';
import { patch } from '@/retained/lib/auth/auth-fetch';

vi.mock('@/retained/hooks/useOrgLapsed', () => ({ useOrgLapsed: () => true, LAPSED_LOOSEN_NOTE: 'Removing access still works.' }));
vi.mock('@/retained/hooks/useDrive', () => ({ useDriveStore: (select: (state: { drives: { id: string; orgId: string }[] }) => unknown) => select({ drives: [{ id: 'product', orgId: 'northwind' }] }) }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ post: vi.fn(), patch: vi.fn().mockResolvedValue({}) }));
vi.mock('@/retained/components/members/PermissionsGrid', () => ({ PermissionsGrid: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const role = { id: 'viewer', name: 'Viewer', isDefault: false, permissions: {}, position: 0, driveWidePermissions: { canView: true, canEdit: false, canShare: false } };

describe('SEAT-9 (partial) role restriction remains available while an organization is lapsed', () => {
  it('disables saving a widened role and explains that only restricting works', () => {
    render(<RoleEditor driveId="product" role={role} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Save role' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Widening a role or making it the default is paused/)).toBeTruthy();
  });

  it('allows an existing grant to be narrowed and sends the narrower permissions', async () => {
    render(<RoleEditor driveId="product" role={{ ...role, driveWidePermissions: { canView: true, canEdit: true, canShare: false } }} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Edit' }));
    const save = screen.getByRole('button', { name: 'Save role' });
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/drives/product/roles/viewer', expect.objectContaining({ driveWidePermissions: { canView: true, canEdit: false, canShare: false } })));
  });

  it('disables making a new role the default while allowing an unassigned non-default role', () => {
    render(<RoleEditor driveId="product" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Save role' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'Default role' }));
    expect(screen.getByRole('button', { name: 'Save role' }).hasAttribute('disabled')).toBe(true);
  });
});

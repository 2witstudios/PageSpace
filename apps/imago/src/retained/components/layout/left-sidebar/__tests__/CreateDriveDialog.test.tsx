// @vitest-environment jsdom
import '@/retained/test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/retained/lib/auth/auth-fetch';

type Org = { id: string; name: string; slug: string; avatarUrl: null; role: 'OWNER' | 'ADMIN' | 'MEMBER'; canCreateDrives: boolean };

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
  orgs: [] as Org[],
  currentDriveId: null as string | null,
  drives: [] as Array<{ id: string; orgId: string | null }>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));
vi.mock('@/retained/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/retained/lib/auth/auth-fetch')>()), post: mocks.post }));
vi.mock('@/retained/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ organizations: mocks.orgs }) }));
vi.mock('@/retained/hooks/useDrive', () => ({
  useDriveStore: (select: (s: Record<string, unknown>) => unknown) =>
    select({ drives: mocks.drives, currentDriveId: mocks.currentDriveId, addDrive: vi.fn(), setCurrentDrive: vi.fn(), fetchDrives: vi.fn() }),
}));

import CreateDriveDialog from '../CreateDriveDialog';

const org = (id: string, name: string, canCreateDrives: boolean): Org => ({ id, name, slug: id, avatarUrl: null, role: 'MEMBER', canCreateDrives });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgs = [];
  mocks.currentDriveId = null;
  mocks.drives = [];
  mocks.post.mockResolvedValue({ id: 'd_new', name: 'Engineering' });
});

const create = async (name: string) => {
  await userEvent.type(screen.getByLabelText('Name'), name);
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
};

describe('DRV-3 (partial) the create-drive dialog creates in the org context the person is in', () => {
  it('someone in no org sees no owner choice and creates a personal drive', async () => {
    render(<CreateDriveDialog isOpen setIsOpen={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Owner' })).not.toBeInTheDocument();
    await create('Notes');
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/drives', { name: 'Notes' }));
  });

  it('opened while in an org drive, the new drive defaults to that org; only orgs that let the person create drives are offered', async () => {
    mocks.orgs = [org('org_nw', 'Northwind Labs', true), org('org_acme', 'Acme', false)];
    mocks.drives = [{ id: 'd_product', orgId: 'org_nw' }];
    mocks.currentDriveId = 'd_product';
    render(<CreateDriveDialog isOpen setIsOpen={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Owner' })).toHaveTextContent('Northwind Labs');
    await userEvent.click(screen.getByRole('combobox', { name: 'Owner' }));
    expect(await screen.findByRole('option', { name: 'Personal' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Acme' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Northwind Labs' }));
    await create('Engineering');
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/drives', { name: 'Engineering', orgId: 'org_nw' }));
  });

  it('outside any org context it defaults to Personal, and the person can choose one of their orgs instead', async () => {
    mocks.orgs = [org('org_nw', 'Northwind Labs', true)];
    mocks.drives = [{ id: 'd_mine', orgId: null }];
    mocks.currentDriveId = 'd_mine';
    render(<CreateDriveDialog isOpen setIsOpen={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Owner' })).toHaveTextContent('Personal');
    await userEvent.click(screen.getByRole('combobox', { name: 'Owner' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Northwind Labs' }));
    await create('Engineering');
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/drives', { name: 'Engineering', orgId: 'org_nw' }));
  });

  it('an explicit org context (opened from an org header) wins, and a refusal from the server is shown', async () => {
    mocks.orgs = [org('org_nw', 'Northwind Labs', true)];
    mocks.post.mockRejectedValue(new ApiRequestError('Only organization Owners and Admins can create drives in this organization.', 403, { code: 'POLICY_FORBIDS_CREATE' }));
    render(<CreateDriveDialog isOpen setIsOpen={vi.fn()} contextOrgId="org_nw" />);
    await create('Engineering');
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/drives', { name: 'Engineering', orgId: 'org_nw' }));
    expect(mocks.toastError).toHaveBeenCalledWith('Only organization Owners and Admins can create drives in this organization.');
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

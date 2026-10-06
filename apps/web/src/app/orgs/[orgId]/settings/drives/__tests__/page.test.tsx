import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as 'OWNER' | 'ADMIN' | 'MEMBER',
  notice: undefined as undefined | Record<string, unknown>,
  reads: {} as Record<string, unknown>,
  drives: [] as Array<Record<string, unknown>>,
  moveDriveIntoOrg: vi.fn(),
  changeDriveVisibility: vi.fn(),
  floor: 'view' as 'view' | 'edit',
  post: vi.fn(),
  fetchDrives: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('swr', async (importOriginal) => ({ ...(await importOriginal<typeof import('swr')>()), useSWRConfig: () => ({ mutate: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: (select: (s: { drives: unknown[]; fetchDrives: () => void }) => unknown) => select({ drives: mocks.drives, fetchDrives: mocks.fetchDrives }),
}));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({
    org: { organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, ownerId: 'u_jono', createdAt: '' }, viewer: { userId: 'u_priya', role: mocks.role }, billingNotice: mocks.notice },
    isLoading: false,
    mutate: vi.fn(),
  }),
  useOrgRealtime: vi.fn(),
  useOrgAdminRead: (key: string) => ({ data: key.endsWith('/policies') ? { policies: { openDriveRoleFloor: mocks.floor } } : mocks.reads[key] }),
}));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()), post: mocks.post }));
vi.mock('@/lib/orgs/org-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/orgs/org-api')>()), moveDriveIntoOrg: mocks.moveDriveIntoOrg, changeDriveVisibility: mocks.changeDriveVisibility }));

import OrgDrivesPage from '../page';

const entry = (id: string, name: string, orgVisibility: string, lead: string) => ({ id, name, slug: id, orgVisibility, lead: { id: `u_${lead}`, name: lead, image: null }, joined: true, joinRequest: null, canRequest: false });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.notice = undefined;
  mocks.reads = {
    '/api/orgs/org_nw/drives': { drives: [entry('d_prod', 'Product', 'OPEN', 'Priya Nair'), entry('d_cr', 'Customer Research', 'RESTRICTED', 'Lena Schulz'), entry('d_fin', 'Finance', 'PRIVATE', 'Jono Woodall')] },
    '/api/orgs/org_nw/drives/usage': { usage: [{ driveId: 'd_prod', memberCount: 12, guestCount: 1, storageBytes: 9.2 * 1024 ** 3 }, { driveId: 'd_fin', memberCount: 3, guestCount: 0, storageBytes: 0.6 * 1024 ** 3 }] },
  };
  mocks.floor = 'view';
  mocks.reads['/api/orgs/org_nw/drives/trashed'] = { drives: [{ id: 'd_secret', name: 'Board minutes', trashedAt: null, lead: { id: 'u_jono', name: 'Jono Woodall' } }] };
  mocks.changeDriveVisibility.mockResolvedValue({ drive: { id: 'd_cr' } });
  mocks.drives = [
    { id: 'd_side', name: 'Side project', isOwned: true, orgId: null, isTrashed: false, kind: 'STANDARD' },
    { id: 'd_home', name: 'Home', isOwned: true, orgId: null, isTrashed: false, kind: 'HOME' },
    { id: 'd_old', name: 'Old wiki', isOwned: true, orgId: 'org_nw', isTrashed: true },
  ];
  mocks.moveDriveIntoOrg.mockResolvedValue({ drive: { id: 'd_side' } });
  mocks.post.mockResolvedValue({});
});

const row = (name: string) => screen.getByText(name).closest('div.flex.flex-wrap') as HTMLElement;

describe('org Drives page', () => {
  it('UI-7 (partial) DRV-4 (partial): each drive with its lead, visibility badge, members and guests, and storage', () => {
    render(<OrgDrivesPage />);
    expect(within(row('Product')).getByText('Lead: Priya Nair')).toBeTruthy();
    expect(within(row('Product')).getByRole('combobox', { name: 'Visibility of Product' }).textContent).toContain('Open');
    expect(within(row('Product')).getByText('12 · 1 guest')).toBeTruthy();
    expect(within(row('Product')).getByText('9.2 GB')).toBeTruthy();
    expect(within(row('Customer Research')).getByRole('combobox').textContent).toContain('Restricted');
    expect(within(row('Finance')).getByRole('combobox').textContent).toContain('Private');
    expect(within(row('Product')).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/dashboard/d_prod/settings');
    expect(screen.getByText('What visibility means')).toBeTruthy();
  });

  it('UI-7 (partial): the Trashed tab lists every trashed org drive from the org read, Private ones the admin is not in included', async () => {
    render(<OrgDrivesPage />);
    await userEvent.click(screen.getByRole('tab', { name: /Trashed/ }));
    expect(screen.getByText('Board minutes')).toBeTruthy();
    expect(screen.queryByText('Old wiki')).toBeNull();
    expect(screen.queryByText('Product')).toBeNull();
  });

  it('DRV-2 (partial): Move a drive in offers only my personal drives (never Home) and moves the chosen ones', async () => {
    render(<OrgDrivesPage />);
    await userEvent.click(screen.getByRole('button', { name: /Move a drive in/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Home')).toBeNull();
    await userEvent.click(within(dialog).getByLabelText('Move Side project'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move in' }));
    await waitFor(() => expect(mocks.moveDriveIntoOrg).toHaveBeenCalledWith('d_side', 'org_nw', 'OPEN'));
  });

  it('DRV-3 (partial): New drive creates it owned by the org', async () => {
    render(<OrgDrivesPage />);
    await userEvent.click(screen.getByRole('button', { name: /New drive/ }));
    await userEvent.type(await screen.findByLabelText('Name'), 'Roadmaps');
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/drives', { name: 'Roadmaps', orgId: 'org_nw', orgVisibility: 'OPEN' }));
  });

  it('POL-6 (partial) DRV-4 (partial): under an Edit floor New drive and Move-in default to Restricted, and say how to reach Open', async () => {
    mocks.floor = 'edit';
    render(<OrgDrivesPage />);
    await userEvent.click(screen.getByRole('button', { name: /New drive/ }));
    expect(screen.getByRole('combobox', { name: 'Visibility for the new drive' }).textContent).toContain('Restricted');
    expect(screen.getAllByText(/Edit default role in its Roles, then switch it to Open/).length).toBeGreaterThan(0);
    await userEvent.type(await screen.findByLabelText('Name'), 'Roadmaps');
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/drives', { name: 'Roadmaps', orgId: 'org_nw', orgVisibility: 'RESTRICTED' }));
    await userEvent.click(screen.getByRole('button', { name: /Move a drive in/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Visibility for the moved drives' }).textContent).toContain('Restricted');
    await userEvent.click(within(dialog).getByLabelText('Move Side project'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move in' }));
    await waitFor(() => expect(mocks.moveDriveIntoOrg).toHaveBeenCalledWith('d_side', 'org_nw', 'RESTRICTED'));
  });

  it('POL-6 (partial): a drive row switches visibility; an Open refused under the floor explains the Edit default role', async () => {
    mocks.changeDriveVisibility.mockRejectedValue(new ApiRequestError('raw', 403, { error: 'raw', code: 'POLICY_OPEN_ROLE_FLOOR' }));
    render(<OrgDrivesPage />);
    await userEvent.click(within(row('Customer Research')).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Open' }));
    await waitFor(() => expect(mocks.changeDriveVisibility).toHaveBeenCalledWith('d_cr', 'OPEN'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('give it an Edit default role')));
  });

  it('SEAT-9 (partial): while lapsed, creating org drives and moving drives in are paused', () => {
    mocks.notice = { kind: 'reactivate', reason: 'unpaid', canManageBilling: true };
    render(<OrgDrivesPage />);
    expect((screen.getByRole('button', { name: /New drive/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Move a drive in/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Moving drives in and creating org drives are paused while unpaid\./)).toBeTruthy();
  });

  it('SEAT-9 (partial) D-OW-33: while lapsed a drive row offers only less open visibilities; making a drive less open still works', async () => {
    mocks.notice = { kind: 'reactivate', reason: 'unpaid', canManageBilling: true };
    render(<OrgDrivesPage />);
    expect(screen.getByText(/Making a drive more open is paused while unpaid/)).toBeTruthy();
    await userEvent.click(within(row('Customer Research')).getByRole('combobox'));
    expect((await screen.findByRole('option', { name: 'Open' })).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: 'Private' }).getAttribute('aria-disabled')).not.toBe('true');
    await userEvent.click(screen.getByRole('option', { name: 'Private' }));
    await waitFor(() => expect(mocks.changeDriveVisibility).toHaveBeenCalledWith('d_cr', 'PRIVATE'));
    expect(mocks.changeDriveVisibility).not.toHaveBeenCalledWith('d_cr', 'OPEN');
  });
});


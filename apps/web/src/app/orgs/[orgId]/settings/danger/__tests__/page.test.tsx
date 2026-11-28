import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ role: 'OWNER' as 'OWNER' | 'ADMIN', post: vi.fn(), del: vi.fn(), push: vi.fn(), patch: vi.fn() }));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }), useRouter: () => ({ push: mocks.push }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('swr', async (importOriginal) => ({ ...(await importOriginal<typeof import('swr')>()), useSWRConfig: () => ({ mutate: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useDrive', () => ({ useDriveStore: (select: (s: { fetchDrives: () => void }) => unknown) => select({ fetchDrives: vi.fn() }) }));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({ org: { organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, ownerId: 'u_jono', createdAt: '' }, viewer: { userId: 'u_jono', role: mocks.role } }, isLoading: false, mutate: vi.fn() }),
  useOrgRealtime: vi.fn(),
  useOrgAdminRead: (key: string) => ({
    data: key.endsWith('/members')
      ? { members: [{ userId: 'u_jono', role: 'OWNER', name: 'Jono Woodall', email: 'j@n.com', image: null, joinedAt: '' }, { userId: 'u_priya', role: 'ADMIN', name: 'Priya Nair', email: 'p@n.com', image: null, joinedAt: '' }] }
      : { drives: [{ id: 'd_prod', name: 'Product', slug: 'p', orgVisibility: 'OPEN', lead: { id: 'u_jono', name: 'Jono', image: null }, joined: true, joinRequest: null, canRequest: false }] },
  }),
}));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()), post: mocks.post, del: mocks.del, patch: mocks.patch }));

import OrgDangerPage from '../page';
import OrgGeneralPage from '../../general/page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'OWNER';
  mocks.post.mockResolvedValue({ ownerId: 'u_priya' });
  mocks.del.mockResolvedValue({ deleted: true, drives: [] });
  mocks.patch.mockResolvedValue({ organization: {} });
});

describe('Danger Zone', () => {
  it('ORG-1 (partial): the Owner transfers ownership to another member', async () => {
    render(<OrgDangerPage />);
    await userEvent.click(screen.getByRole('combobox', { name: 'New owner' }));
    expect(screen.queryByRole('option', { name: 'Jono Woodall' })).toBeNull();
    await userEvent.click(await screen.findByRole('option', { name: 'Priya Nair' }));
    await userEvent.click(screen.getByRole('button', { name: 'Transfer ownership' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/orgs/org_nw/transfer-ownership', { toUserId: 'u_priya' }));
  });

  it('ORG-6 (partial): deleting needs a choice for every drive and the typed name; nothing is orphaned', async () => {
    render(<OrgDangerPage />);
    const remove = screen.getByRole('button', { name: 'Delete organization' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    await userEvent.click(screen.getByRole('combobox', { name: 'What happens to Product' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Move to trash' }));
    expect(remove.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Type Northwind Labs to confirm'), 'Northwind Labs');
    expect(remove.disabled).toBe(false);
    await userEvent.click(remove);
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/api/orgs/org_nw', { drives: [{ driveId: 'd_prod', action: 'trash' }] }));
    expect(mocks.push).toHaveBeenCalledWith('/settings');
  });

  it('UI-11 (partial): an Admin does not see the Danger Zone', () => {
    mocks.role = 'ADMIN';
    render(<OrgDangerPage />);
    expect(screen.getByText('Only the Owner of Northwind Labs can see this page.')).toBeTruthy();
  });
});

describe('General', () => {
  it('ORG-1 (partial): renames the organization and shows its Owner', async () => {
    mocks.role = 'ADMIN';
    render(<OrgGeneralPage />);
    expect(screen.getByText(/Jono Woodall owns Northwind Labs/)).toBeTruthy();
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Northwind');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/orgs/org_nw', { name: 'Northwind' }));
  });
});

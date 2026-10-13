import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const mocks = vi.hoisted(() => ({
  avatarUrl: null as string | null,
  uploadOrgAvatar: vi.fn(),
  removeOrgAvatar: vi.fn(),
  mutate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('swr', async (importOriginal) => ({ ...(await importOriginal<typeof import('swr')>()), useSWRConfig: () => ({ mutate: mocks.mutate }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({
    org: { organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: mocks.avatarUrl, ownerId: 'u_jono', createdAt: '' }, viewer: { userId: 'u_priya', role: 'ADMIN' } },
    isLoading: false,
    mutate: vi.fn(),
  }),
  useOrgRealtime: vi.fn(),
  useOrgAdminRead: () => ({ data: { members: [] } }),
}));
vi.mock('@/lib/orgs/org-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orgs/org-api')>()),
  uploadOrgAvatar: mocks.uploadOrgAvatar,
  removeOrgAvatar: mocks.removeOrgAvatar,
}));

import OrgGeneralPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.avatarUrl = null;
});

describe('ORG-1 (partial) Org Settings › General sets the org avatar by uploading an image', () => {
  it('an Admin picks an image file; it is uploaded and the org is refetched (there is no URL field anywhere)', async () => {
    mocks.uploadOrgAvatar.mockResolvedValue({ organization: { id: 'org_nw', avatarUrl: '/api/orgs/org_nw/avatar/avatar-abc123.png' } });
    render(<OrgGeneralPage />);
    expect(screen.queryByLabelText(/url/i, { selector: 'input[type="url"]' })).not.toBeInTheDocument();
    const input = screen.getByLabelText('Upload avatar image');
    expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/gif,image/webp');
    const file = new File([new Uint8Array([1])], 'logo.png', { type: 'image/png' });
    await userEvent.upload(input, file);
    await waitFor(() => expect(mocks.uploadOrgAvatar).toHaveBeenCalledWith('org_nw', file));
    expect(mocks.mutate).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Remove avatar' })).not.toBeInTheDocument();
  });

  it('an existing avatar can be removed; a refused upload says why', async () => {
    mocks.avatarUrl = '/api/orgs/org_nw/avatar/avatar-abc123.png';
    mocks.removeOrgAvatar.mockResolvedValue({ organization: { id: 'org_nw', avatarUrl: null } });
    render(<OrgGeneralPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove avatar' }));
    await waitFor(() => expect(mocks.removeOrgAvatar).toHaveBeenCalledWith('org_nw'));

    mocks.uploadOrgAvatar.mockRejectedValue(new ApiRequestError('The image is larger than 5 MB', 400, { error: 'The image is larger than 5 MB', code: 'invalid_request' }));
    await userEvent.upload(screen.getByLabelText('Upload avatar image'), new File([new Uint8Array([1])], 'big.png', { type: 'image/png' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  });
});

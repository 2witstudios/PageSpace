import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const mocks = vi.hoisted(() => ({ role: 'ADMIN' as 'ADMIN' | 'MEMBER', post: vi.fn(), del: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('swr', async (importOriginal) => ({ ...(await importOriginal<typeof import('swr')>()), useSWRConfig: () => ({ mutate: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({ org: { organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'n', avatarUrl: null, ownerId: 'u', createdAt: '' }, viewer: { userId: 'u', role: mocks.role } }, isLoading: false, mutate: vi.fn() }),
  useOrgRealtime: vi.fn(),
  useOrgAdminRead: () => ({
    data: {
      domains: [
        { id: 'dom_1', domain: 'northwind.com', verifiedAt: '2026-09-02T00:00:00Z', verifiedMethod: 'dns', emailSentTo: null, emailTokenExpiresAt: null, dnsRecord: { type: 'TXT', name: '_pagespace-verification.northwind.com', value: 'pagespace-domain-verification=a' } },
        { id: 'dom_2', domain: 'northwind.io', verifiedAt: null, verifiedMethod: null, emailSentTo: null, emailTokenExpiresAt: null, dnsRecord: { type: 'TXT', name: '_pagespace-verification.northwind.io', value: 'pagespace-domain-verification=b' } },
      ],
    },
  }),
}));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()), post: mocks.post, del: mocks.del }));

import OrgSecurityPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.post.mockResolvedValue({});
  mocks.del.mockResolvedValue({ removed: true });
});

describe('org Security page', () => {
  it('UI-7 (partial) SEC-1 (partial): verified and unverified domains, with the DNS record to add', () => {
    render(<OrgSecurityPage />);
    expect(screen.getByText('Verified by DNS')).toBeTruthy();
    expect(screen.getByText('Not verified')).toBeTruthy();
    expect(screen.getByText('_pagespace-verification.northwind.io')).toBeTruthy();
    expect(screen.getByText('pagespace-domain-verification=b')).toBeTruthy();
  });

  it('SEC-4 (partial): names SSO and SCIM as not part of organizations; two-step and session age are not available yet (D-OW-1)', () => {
    render(<OrgSecurityPage />);
    expect(screen.getByText('Single sign-on (SSO) and SCIM user provisioning are not part of organizations yet.')).toBeTruthy();
    expect(screen.getByText(/two-step sign-in and a maximum session age .* are not available yet/)).toBeTruthy();
  });

  it('SEC-1 (partial): adds a domain, checks DNS, or sends a verification email to a chosen mailbox', async () => {
    render(<OrgSecurityPage />);
    await userEvent.type(screen.getByLabelText('Domain'), 'northwind.dev');
    await userEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/orgs/org_nw/domains', { domain: 'northwind.dev' }));
    await userEvent.click(screen.getByRole('button', { name: 'Check DNS' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/orgs/org_nw/domains/dom_2/verify', { method: 'dns' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send verification email' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/orgs/org_nw/domains/dom_2/verify', { method: 'email', mailbox: 'admin' }));
  });

  it('a DNS record not found yet shows its copy', async () => {
    mocks.post.mockRejectedValue(new ApiRequestError('raw', 422, { error: 'raw', code: 'proof_not_found' }));
    render(<OrgSecurityPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Check DNS' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('We could not find the verification record yet. DNS changes can take a while.'));
  });

  it('SEC-1 (partial): an Admin lets a removed person rejoin by domain (D-OW-27)', async () => {
    mocks.post.mockResolvedValue({ cleared: true });
    render(<OrgSecurityPage />);
    await userEvent.type(screen.getByLabelText('Email address to let rejoin'), 'lou@northwind.com');
    await userEvent.click(screen.getByRole('button', { name: 'Let them rejoin' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/orgs/org_nw/suppressions/clear', { email: 'lou@northwind.com' }));
  });
});

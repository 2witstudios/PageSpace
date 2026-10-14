import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/auth/auth-fetch';
import { DEFAULT_ORG_POLICIES } from '@pagespace/lib/organizations/policies-core';

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as 'ADMIN' | 'MEMBER',
  policies: {} as Record<string, unknown>,
  preview: { members: 3, guests: 0, credentials: 5 },
  reads: [] as string[],
  post: vi.fn(),
  del: vi.fn(),
  patch: vi.fn(),
  reauth: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('swr', async (importOriginal) => ({ ...(await importOriginal<typeof import('swr')>()), useSWRConfig: () => ({ mutate: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo } }));
vi.mock('@/lib/auth/session-reauthentication', () => ({ reauthenticateCurrentSession: mocks.reauth }));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({ org: { organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'n', avatarUrl: null, ownerId: 'u', createdAt: '' }, viewer: { userId: 'u', role: mocks.role } }, isLoading: false, mutate: vi.fn() }),
  useOrgRealtime: vi.fn(),
  useOrgAdminRead: (key: string | null) => {
    if (key) mocks.reads.push(key);
    if (key === '/api/orgs/org_nw/domains') {
      return {
        data: {
          domains: [
            { id: 'dom_1', domain: 'northwind.com', verifiedAt: '2026-09-02T00:00:00Z', verifiedMethod: 'dns', emailSentTo: null, emailTokenExpiresAt: null, dnsRecord: { type: 'TXT', name: '_pagespace-verification.northwind.com', value: 'pagespace-domain-verification=a' } },
            { id: 'dom_2', domain: 'northwind.io', verifiedAt: null, verifiedMethod: null, emailSentTo: null, emailTokenExpiresAt: null, dnsRecord: { type: 'TXT', name: '_pagespace-verification.northwind.io', value: 'pagespace-domain-verification=b' } },
          ],
        },
      };
    }
    if (key === '/api/orgs/org_nw/policies') return { data: { policies: mocks.policies } };
    if (key?.startsWith('/api/orgs/org_nw/policies/sign-in-preview')) return { data: mocks.preview };
    return { data: undefined };
  },
}));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()), post: mocks.post, del: mocks.del, patch: mocks.patch }));

import OrgSecurityPage from '../page';
import { SESSION_AGE_OPTIONS, SESSION_AGE_RANGE_TEXT, formatSessionAge } from '@/lib/orgs/sign-in-policy-ui';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.reads = [];
  mocks.policies = { ...DEFAULT_ORG_POLICIES };
  mocks.preview = { members: 3, guests: 0, credentials: 5 };
  mocks.post.mockResolvedValue({});
  mocks.del.mockResolvedValue({ removed: true });
  mocks.patch.mockResolvedValue({ signInBlocked: { members: 3, guests: 0, credentials: 5 } });
  mocks.reauth.mockResolvedValue({ status: 'done' });
});

describe('org Security page', () => {
  it('UI-7 (partial) SEC-1 (partial): verified and unverified domains, with the DNS record to add', () => {
    render(<OrgSecurityPage />);
    expect(screen.getByText('Verified by DNS')).toBeTruthy();
    expect(screen.getByText('Not verified')).toBeTruthy();
    expect(screen.getByText('_pagespace-verification.northwind.io')).toBeTruthy();
    expect(screen.getByText('pagespace-domain-verification=b')).toBeTruthy();
  });

  it('SEC-4 the Security page names SSO and SCIM as out of scope', () => {
    render(<OrgSecurityPage />);
    const section = screen.getByRole('region', { name: 'Single sign-on and SCIM' });
    expect(section.textContent).toContain('Single sign-on (SSO) and SCIM user provisioning are out of scope for organizations.');
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

describe('org Security page: sign-in requirements (D-OW-45, D-OW-47)', () => {
  it('UI-7 (partial) SEC-2 (partial) SEC-3 (partial) shows both controls with the stored values and the allowed age range in human units', () => {
    mocks.policies = { ...DEFAULT_ORG_POLICIES, maximumSessionAgeMinutes: 60 };
    render(<OrgSecurityPage />);
    expect(screen.queryByText(/not available yet/)).toBeNull();
    expect((screen.getByRole('switch', { name: 'Require strong sign-in (passkey)' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('combobox', { name: 'Maximum sign-in age' }).textContent).toBe('1 hour');
    expect(screen.getByText(new RegExp(SESSION_AGE_RANGE_TEXT.replace('.', '\\.')))).toBeTruthy();
    expect(SESSION_AGE_RANGE_TEXT).toBe('From 15 minutes to 30 days.');
  });

  it('SEC-2 (partial) previews how many members a change would send back to sign in, before saving (counts only)', async () => {
    render(<OrgSecurityPage />);
    expect(mocks.reads.some((k) => k.includes('sign-in-preview'))).toBe(false);
    await userEvent.click(screen.getByRole('switch', { name: 'Require strong sign-in (passkey)' }));
    expect(await screen.findByText("3 members would need to sign in again before opening Northwind Labs's drives.")).toBeTruthy();
    expect(mocks.reads).toContain('/api/orgs/org_nw/policies/sign-in-preview?requireStrongSignIn=true');
  });

  it('SEC-2 (partial) turning strong sign-in on runs the passkey ceremony BEFORE saving, so the Admin cannot lock themselves out (D-OW-47)', async () => {
    const order: string[] = [];
    mocks.reauth.mockImplementation(async () => { order.push('passkey'); return { status: 'done' }; });
    mocks.patch.mockImplementation(async () => { order.push('save'); return { signInBlocked: { members: 3, guests: 0, credentials: 5 } }; });
    render(<OrgSecurityPage />);
    expect(screen.getByText(/turning on strong sign-in first asks you to confirm with your passkey/)).toBeTruthy();

    await userEvent.click(screen.getByRole('switch', { name: 'Require strong sign-in (passkey)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm with passkey and save' }));

    await waitFor(() => expect(order).toEqual(['passkey', 'save']));
    expect(mocks.reauth).toHaveBeenCalledWith('org_strong_sign_in_required');
    expect(mocks.patch).toHaveBeenCalledWith('/api/orgs/org_nw/policies', { requireStrongSignIn: true });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Saved. 3 members need to sign in again to open Northwind Labs's drives."));
  });

  it('SEC-2 (partial) a cancelled passkey ceremony saves nothing', async () => {
    mocks.reauth.mockRejectedValue(new Error('NotAllowedError'));
    render(<OrgSecurityPage />);
    await userEvent.click(screen.getByRole('switch', { name: 'Require strong sign-in (passkey)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm with passkey and save' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('SEC-3 (partial) when the server says the change would lock the Admin out, it runs the named ceremony and saves again (D-OW-47)', async () => {
    mocks.policies = { ...DEFAULT_ORG_POLICIES, requireStrongSignIn: true };
    mocks.patch
      .mockRejectedValueOnce(new ApiRequestError('locked out', 403, { code: 'org_policy_would_lock_out_actor', requires: 'org_reauthentication_required' }))
      .mockResolvedValueOnce({ signInBlocked: null });
    render(<OrgSecurityPage />);
    await userEvent.click(screen.getByRole('switch', { name: 'Require strong sign-in (passkey)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save sign-in requirements' }));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(mocks.reauth).toHaveBeenCalledWith('org_reauthentication_required');
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Saved.');
  });

  it('SEC-2 (partial) the preview and the saved notice count guests apart from members (review #2866 B4)', async () => {
    mocks.preview = { members: 2, guests: 1, credentials: 4 };
    mocks.patch.mockResolvedValue({ signInBlocked: { members: 0, guests: 1, credentials: 1 } });
    mocks.policies = { ...DEFAULT_ORG_POLICIES, requireStrongSignIn: true };
    render(<OrgSecurityPage />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Maximum sign-in age' }));
    await userEvent.click(await screen.findByRole('option', { name: '1 hour' }));
    expect(await screen.findByText("2 members and 1 guest would need to sign in again before opening Northwind Labs's drives.")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save sign-in requirements' }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Saved. 1 guest needs to sign in again to open Northwind Labs's drives."));
  });

  it('SEC-3 (partial) only the changed requirement is sent (review #2866 B2)', async () => {
    render(<OrgSecurityPage />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Maximum sign-in age' }));
    await userEvent.click(await screen.findByRole('option', { name: '1 hour' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save sign-in requirements' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/orgs/org_nw/policies', { maximumSessionAgeMinutes: 60 }));
  });

  it('SEC-3 (partial) a damaged stored age reads as invalid, an unrelated change leaves it unsent, and choosing a valid age repairs it (review #2866 B2)', async () => {
    mocks.policies = { ...DEFAULT_ORG_POLICIES, maximumSessionAgeMinutes: 0 };
    render(<OrgSecurityPage />);
    const age = screen.getByRole('combobox', { name: 'Maximum sign-in age' });
    expect(age.textContent).toBe('Invalid — choose a value');
    expect(mocks.reads.some((k) => k.includes('sign-in-preview'))).toBe(false);

    await userEvent.click(screen.getByRole('switch', { name: 'Require strong sign-in (passkey)' }));
    expect(mocks.reads.some((k) => k.includes('sign-in-preview'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm with passkey and save' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/orgs/org_nw/policies', { requireStrongSignIn: true }));

    mocks.patch.mockClear();
    await userEvent.click(screen.getByRole('combobox', { name: 'Maximum sign-in age' }));
    expect(screen.queryByRole('option', { name: '0 days' })).toBeNull();
    await userEvent.click(await screen.findByRole('option', { name: '1 hour' }));
    expect(screen.getByRole('combobox', { name: 'Maximum sign-in age' }).textContent).toBe('1 hour');
    await userEvent.click(screen.getByRole('button', { name: 'Save sign-in requirements' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/orgs/org_nw/policies', { maximumSessionAgeMinutes: 60 }));
  });

  it('the maximum ages offered stay inside the allowed range and read in human units', () => {
    expect(Math.min(...SESSION_AGE_OPTIONS)).toBe(15);
    expect(Math.max(...SESSION_AGE_OPTIONS)).toBe(43_200);
    expect(SESSION_AGE_OPTIONS.map(formatSessionAge)).toEqual(['15 minutes', '30 minutes', '1 hour', '4 hours', '8 hours', '12 hours', '1 day', '7 days', '30 days']);
  });
});

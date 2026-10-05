import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORG_POLICIES } from '@pagespace/lib/organizations/policies-core';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const mocks = vi.hoisted(() => ({
  notice: undefined as undefined | Record<string, unknown>,
  policies: {} as Record<string, unknown>,
  patchOrgPolicies: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('swr', async (importOriginal) => {
  const real = await importOriginal<typeof import('swr')>();
  return {
    ...real,
    default: () => ({ data: { providers: [{ slug: 'github', name: 'GitHub' }, { slug: 'slack', name: 'Slack' }] } }),
    useSWRConfig: () => ({ mutate: vi.fn() }),
  };
});
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({
    org: { organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, ownerId: 'u_jono', createdAt: '' }, viewer: { userId: 'u_priya', role: 'ADMIN' }, billingNotice: mocks.notice },
    isLoading: false,
    mutate: vi.fn(),
  }),
  useOrgRealtime: vi.fn(),
  useOrgAdminRead: () => ({ data: { policies: mocks.policies } }),
}));
vi.mock('@/lib/orgs/org-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/orgs/org-api')>()), patchOrgPolicies: mocks.patchOrgPolicies }));

import OrgPoliciesPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notice = undefined;
  mocks.policies = { ...DEFAULT_ORG_POLICIES, guests: 'approve', publicShareLinks: false, persistentEnvironments: false, seatAllowanceCents: 150 };
  mocks.patchOrgPolicies.mockResolvedValue({ policies: mocks.policies, changed: [], suspended: {}, restored: {}, blocked: {} });
});

const sw = (name: string) => screen.getByRole('switch', { name }) as HTMLButtonElement;

describe('org Policies page', () => {
  it('UI-7 (partial): the controls match the real policy fields and their values', () => {
    render(<OrgPoliciesPage />);
    expect(screen.getByRole('combobox', { name: 'Guests from outside the organization' }).textContent).toContain('Admins approve');
    expect(sw('Public share links').getAttribute('aria-checked')).toBe('false');
    expect(sw('Publish pages to the web').getAttribute('aria-checked')).toBe('true');
    expect(sw('Persistent environments').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('combobox', { name: 'Lowest default role in Open drives' }).textContent).toContain('View');
    expect((screen.getByLabelText('Seat allowance in credits a month') as HTMLInputElement).value).toBe('150');
    expect(screen.getByRole('checkbox', { name: 'Anthropic' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'GitHub' })).toBeTruthy();
    expect(screen.getByText(/create it Restricted, give it an Edit default role, then switch it to Open/i)).toBeTruthy();
  });

  it('POL-2 (partial): changing the guests policy saves at once and reports what it suspended', async () => {
    mocks.patchOrgPolicies.mockResolvedValue({ policies: {}, changed: ['guests'], suspended: { guests: 3 }, restored: {}, blocked: {} });
    render(<OrgPoliciesPage />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Guests from outside the organization' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Off' }));
    await waitFor(() => expect(mocks.patchOrgPolicies).toHaveBeenCalledWith('org_nw', { guests: 'off' }));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Saved. 3 guests suspended.');
  });

  it('POL-3 (partial) POL-10 (partial): boolean policies are switches', async () => {
    render(<OrgPoliciesPage />);
    await userEvent.click(sw('Public share links'));
    await waitFor(() => expect(mocks.patchOrgPolicies).toHaveBeenCalledWith('org_nw', { publicShareLinks: true }));
    await userEvent.click(sw('Persistent environments'));
    await waitFor(() => expect(mocks.patchOrgPolicies).toHaveBeenCalledWith('org_nw', { persistentEnvironments: true }));
  });

  it('POL-8 (partial): unchecking a provider from Unrestricted allows every other provider explicitly', async () => {
    render(<OrgPoliciesPage />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'xAI (Grok)' }));
    await waitFor(() => expect(mocks.patchOrgPolicies).toHaveBeenCalled());
    const list = mocks.patchOrgPolicies.mock.calls[0][1].providerAllowlist as string[];
    expect(list).toContain('anthropic');
    expect(list).not.toContain('xai');
  });

  it('POL-7 (partial): the seat allowance is saved in credits as whole cents', async () => {
    render(<OrgPoliciesPage />);
    const input = screen.getByLabelText('Seat allowance in credits a month');
    await userEvent.clear(input);
    await userEvent.type(input, '200');
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    await waitFor(() => expect(mocks.patchOrgPolicies).toHaveBeenCalledWith('org_nw', { seatAllowanceCents: 200 }));
  });

  it('POL-6 (partial): raising the floor while an Open drive sits below it lists those drives', async () => {
    mocks.patchOrgPolicies.mockRejectedValue(new ApiRequestError('raw', 403, { error: 'raw', code: 'org_policy', policy: 'openDriveRoleFloor', drives: [{ id: 'd_prod', name: 'Product' }] }));
    render(<OrgPoliciesPage />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Lowest default role in Open drives' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Edit' }));
    expect(await screen.findByRole('link', { name: 'Product' })).toBeTruthy();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('SEAT-9 (partial) D-OW-33: while lapsed, restricting works and loosening is paused', async () => {
    mocks.notice = { kind: 'reactivate', reason: 'canceled', canManageBilling: true };
    render(<OrgPoliciesPage />);
    expect(sw('Public share links').disabled).toBe(true);
    expect(sw('Publish pages to the web').disabled).toBe(false);
    expect(screen.getByText('Off is available. On is paused while unpaid.')).toBeTruthy();
    await userEvent.click(screen.getByRole('combobox', { name: 'Guests from outside the organization' }));
    expect((await screen.findByRole('option', { name: 'On' })).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: 'Off' }).getAttribute('aria-disabled')).not.toBe('true');
    await userEvent.keyboard('{Escape}');
    const input = screen.getByLabelText('Seat allowance in credits a month');
    await userEvent.clear(input);
    await userEvent.type(input, '200');
    expect((screen.getAllByRole('button', { name: 'Save' })[0] as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(input);
    await userEvent.type(input, '100');
    expect((screen.getAllByRole('button', { name: 'Save' })[0] as HTMLButtonElement).disabled).toBe(false);
  });
});

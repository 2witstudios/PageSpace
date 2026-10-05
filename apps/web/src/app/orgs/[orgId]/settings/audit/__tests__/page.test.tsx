import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as 'OWNER' | 'ADMIN' | 'MEMBER',
  keys: [] as string[],
  fetchWithAuth: vi.fn(),
  fetchJSON: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({
    org: { organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, ownerId: 'u_jono', createdAt: '' }, viewer: { userId: 'u_priya', role: mocks.role } },
    isLoading: false,
    mutate: vi.fn(),
  }),
  useOrgRealtime: vi.fn(),
  useOrgAdminRead: (key: string) => {
    mocks.keys.push(key);
    if (key === '/api/orgs/org_nw/drives') return { data: { drives: [{ id: 'd_cr', name: 'Customer Research', slug: 'cr', orgVisibility: 'RESTRICTED', lead: { id: 'u', name: 'L', image: null }, joined: true, joinRequest: null, canRequest: false }] } };
    return {
      data: {
        entries: [
          { timestamp: new Date(Date.now() - 2 * 3_600_000).toISOString(), category: 'visibility', eventType: 'org.drive.visibility_changed', actorId: 'u_priya', actorName: 'Priya Nair', resourceType: 'drive', resourceId: 'd_cr', driveId: 'd_cr', details: { from: 'OPEN', to: 'RESTRICTED' } },
          { timestamp: new Date(Date.now() - 86_400_000).toISOString(), category: 'private_drive_access', eventType: 'authz.access.granted', actorId: 'u_dana', actorName: 'Dana Kim', resourceType: 'drive', resourceId: 'd_fin', driveId: null, details: {} },
        ],
        nextCursor: 42,
      },
      isLoading: false,
    };
  },
}));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()), fetchWithAuth: mocks.fetchWithAuth, fetchJSON: mocks.fetchJSON }));

import OrgAuditPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.keys = [];
  mocks.fetchJSON.mockResolvedValue({ entries: [{ timestamp: new Date().toISOString(), category: 'seats', eventType: 'org.seat.refused', actorId: null, actorName: null, resourceType: null, resourceId: null, driveId: null, details: {} }], nextCursor: null });
});

describe('org Audit log', () => {
  it('AUD-3 (partial) UI-7 (partial): events read as who did what, with the drive, the category and when', () => {
    render(<OrgAuditPage />);
    expect(screen.getByText('Priya Nair')).toBeTruthy();
    expect(screen.getByText(/changed a drive’s visibility/)).toBeTruthy();
    expect(screen.getAllByText('Customer Research').length).toBeGreaterThan(0);
    expect(screen.getByText(/opened a Private drive as an org admin/)).toBeTruthy();
    expect(screen.getAllByText('Admin access').length).toBeGreaterThan(0);
    expect(screen.getByText('2 hours ago')).toBeTruthy();
    // AUD-1: what changed, from what to what (review P2-8).
    expect(screen.getByText('Open → Restricted')).toBeTruthy();
  });

  it('AUD-3 (partial): starts on the last 30 days and refetches with a category filter', async () => {
    render(<OrgAuditPage />);
    expect(mocks.keys.some((k) => /\/api\/orgs\/org_nw\/audit\?from=/.test(k))).toBe(true);
    await userEvent.click(screen.getByRole('combobox', { name: 'Event type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Policies' }));
    await waitFor(() => expect(mocks.keys.some((k) => k.includes('category=policies'))).toBe(true));
  });

  it('Load more pages with the cursor', async () => {
    render(<OrgAuditPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(mocks.fetchJSON).toHaveBeenCalledWith(expect.stringContaining('before=42')));
    expect(await screen.findByText(/was refused a seat/)).toBeTruthy();
  });

  it('AUD-3 (partial): Export CSV downloads with the same filters', async () => {
    mocks.fetchWithAuth.mockResolvedValue(new Response('timestamp,category\n', { status: 200 }));
    const createUrl = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    render(<OrgAuditPage />);
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledWith(expect.stringMatching(/\/api\/orgs\/org_nw\/audit\/export\?from=/)));
    expect(createUrl).toHaveBeenCalled();
  });

  it('a rate-limited export shows its copy', async () => {
    mocks.fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ error: 'x', code: 'rate_limited' }), { status: 429 }));
    render(<OrgAuditPage />);
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Too many attempts. Wait a moment and try again.'));
  });

  it('UI-11 (partial): a plain Member sees no audit log', () => {
    mocks.role = 'MEMBER';
    render(<OrgAuditPage />);
    expect(screen.queryByText('Priya Nair')).toBeNull();
  });
});

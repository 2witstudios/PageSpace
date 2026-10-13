import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drive } from '@/hooks/useDrive';

const mocks = vi.hoisted(() => ({
  role: 'MEMBER' as 'OWNER' | 'ADMIN' | 'MEMBER',
  lapsed: false,
  fetchJSON: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ orgById: (id: string | null | undefined) => (id ? { id, role: mocks.role } : null) }) }));
vi.mock('@/hooks/useOrgLapsed', () => ({ useOrgLapsed: () => mocks.lapsed, LAPSED_LOOSEN_NOTE: 'Paused while unpaid.' }));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchJSON: mocks.fetchJSON,
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
  patch: mocks.patch,
  put: vi.fn(),
  del: vi.fn(),
  ApiRequestError: class extends Error {},
}));

import { DriveJoinRequests } from '../DriveJoinRequests';

const drive = (over: Partial<Drive>): Drive => ({
  id: 'd_fin', name: 'Finance', slug: 'finance', ownerId: 'u_lead', isTrashed: false, trashedAt: null,
  createdAt: '', updatedAt: '', isOwned: false, orgId: 'org_nw', orgVisibility: 'RESTRICTED', ...over,
});
const request = { id: 'jr_1', userId: 'u_marcus', name: 'Marcus', email: 'marcus@example.com', image: null, message: 'Quarter close', requestedAt: '2026-10-01T00:00:00Z' };
const renderCard = (d: Drive) => render(<SWRConfig value={{ provider: () => new Map() }}><DriveJoinRequests drive={d} /></SWRConfig>);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'MEMBER';
  mocks.lapsed = false;
  mocks.fetchJSON.mockResolvedValue({ requests: [request] });
  mocks.patch.mockResolvedValue({ admitted: true });
});

describe('join requests on a Restricted drive (DRV-6)', () => {
  it('DRV-6 (partial) the drive lead sees pending requests with the note and approves one', async () => {
    renderCard(drive({ isOwned: true }));
    expect(await screen.findByText('Marcus')).toBeTruthy();
    expect(screen.getByText(/Quarter close/)).toBeTruthy();
    expect(mocks.fetchJSON).toHaveBeenCalledWith('/api/drives/d_fin/join-requests');
    await userEvent.click(screen.getByRole('button', { name: 'Approve Marcus' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/drives/d_fin/join-requests/jr_1', { decision: 'approve' }));
  });

  it('DRV-6 (partial) an org Admin who is not the lead declines one', async () => {
    mocks.role = 'ADMIN';
    renderCard(drive({}));
    await userEvent.click(await screen.findByRole('button', { name: 'Decline Marcus' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/drives/d_fin/join-requests/jr_1', { decision: 'deny' }));
  });

  it('UI-11 (partial) a plain Member sees no requests, and none are fetched', () => {
    const { container } = renderCard(drive({}));
    expect(container.textContent).toBe('');
    expect(mocks.fetchJSON).not.toHaveBeenCalled();
  });

  it('while the org is unpaid, approving pauses and declining still works (D-OW-33)', async () => {
    mocks.lapsed = true;
    renderCard(drive({ isOwned: true }));
    expect((await screen.findByRole('button', { name: 'Approve Marcus' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Decline Marcus' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

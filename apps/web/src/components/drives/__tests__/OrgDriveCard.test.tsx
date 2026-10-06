import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { Drive } from '@pagespace/lib/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const api = vi.hoisted(() => ({ patch: vi.fn(async () => ({})), put: vi.fn(async () => ({})), del: vi.fn(async () => ({})), fetchWithAuth: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
const orgs = vi.hoisted(() => ({ role: 'MEMBER' as 'OWNER' | 'ADMIN' | 'MEMBER' }));
vi.mock('@/hooks/useMyOrganizations', () => ({
  useMyOrganizations: () => {
    const list = [{ id: 'o-northwind', name: 'Northwind Labs', slug: 'nw', avatarUrl: null, role: orgs.role }];
    return { organizations: list, orgById: (id: string | null) => list.find((o) => o.id === id) ?? null };
  },
}));
const walletState = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/hooks/useDriveWallet', () => ({ useDriveWallet: () => ({ wallet: walletState.wallet }) }));

import { OrgDriveCard } from '../OrgDriveCard';

const drive = (o: Partial<Drive>): Drive => ({
  id: 'd-product', name: 'Product', slug: 'product', ownerId: 'u-priya', isTrashed: false, trashedAt: null,
  createdAt: '', updatedAt: '', isOwned: false, orgId: 'o-northwind', orgVisibility: 'OPEN', ...o,
});
const renderCard = (d: Drive) =>
  render(<SWRConfig value={{ provider: () => new Map() }}><OrgDriveCard drive={d} leadName="Priya Nair" onChanged={vi.fn()} /></SWRConfig>);

beforeEach(() => {
  vi.clearAllMocks();
  orgs.role = 'MEMBER';
  walletState.wallet = null;
  api.fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ members: [{ userId: 'u-priya', name: 'Priya Nair', email: 'p@n.co' }, { userId: 'u-lena', name: 'Lena Schulz', email: 'l@n.co' }] }) });
});

describe('OrgDriveCard on Drive Settings › General', () => {
  it('UI-4 (partial) the lead sees who owns and pays, the wallet summary with its allocation, and can change visibility', async () => {
    walletState.wallet = { viewer: 'lead', allocationCredits: '1,200', spentCredits: '1,008', fallbackRule: 'seat_allowance' };
    renderCard(drive({ isOwned: true }));
    expect(screen.getByText('Owned by Northwind Labs')).toBeTruthy();
    expect(screen.getByText(/1,200 credits a month from the org pool, 1,008 credits spent/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Open/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /Restricted/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/drives/d-product/org', { orgVisibility: 'RESTRICTED' }));
    expect(screen.getByRole('link', { name: /Org settings/ }).getAttribute('href')).toBe('/orgs/o-northwind/settings');
  });

  it('UI-4 (partial) the card shows the drive\'s current visibility, so a change broadcast as drive:updated (drive list refetch) is reflected', () => {
    const { rerender } = renderCard(drive({ isOwned: true }));
    rerender(<SWRConfig value={{ provider: () => new Map() }}><OrgDriveCard drive={drive({ isOwned: true, orgVisibility: 'PRIVATE' })} leadName="Priya Nair" onChanged={vi.fn()} /></SWRConfig>);
    expect(screen.getByRole('radio', { name: /Private/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('UI-4 (partial) a plain org member reads the card but cannot change visibility, the lead, or move the drive', () => {
    renderCard(drive({}));
    expect(screen.getByRole('radio', { name: /Restricted/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Drive lead' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Move out/ })).toBeNull();
    expect(screen.getByText('Priya Nair')).toBeTruthy();
  });

  it('DRV-2 (partial) an org Admin can move the drive out, choosing to keep or remove implicit members (D-OW-10)', async () => {
    orgs.role = 'ADMIN';
    renderCard(drive({}));
    fireEvent.click(screen.getByRole('button', { name: 'Move out of Northwind Labs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep them as invited' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/api/drives/d-product/org', { implicitMembers: 'keep' }));
  });

  it('DRV-2 (partial) the owner of a personal drive can move it into one of their orgs; Home never offers it', async () => {
    renderCard(drive({ orgId: null, isOwned: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Move into organization' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/drives/d-product/org', { orgId: 'o-northwind' }));
    const { container } = renderCard(drive({ id: 'd-home', orgId: null, isOwned: true, kind: 'HOME' }));
    expect(container.innerHTML).toBe('');
  });
});

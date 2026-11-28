import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import GeneralSettingsPage from './page';
const state = vi.hoisted(() => ({ drives: [{ id: 'd1', name: 'Design', kind: 'STANDARD', ownerId: 'u1', orgId: 'o1', orgVisibility: 'OPEN', role: 'ADMIN', isOwned: false, isTrashed: false }], isLoading: false, fetchDrives: vi.fn(), updateDrive: vi.fn() }));
vi.mock('@/retained-adapters/navigation', async importOriginal => ({ ...(await importOriginal<typeof import('@/retained-adapters/navigation')>()), useParams: () => ({ driveId: 'd1' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/retained/hooks/useDrive', () => ({ useDriveStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('@/retained/hooks/usePageTree', () => ({ usePageTree: () => ({ tree: [] }) }));
vi.mock('@/retained/hooks/useDriveWallet', () => ({ useDriveWallet: () => ({ read: null, isLoading: false }) }));
vi.mock('@/ui/settings/imago-access/imago-access-section', () => ({ ImagoAccessSection: () => null }));
vi.mock('@/retained/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ organizations: [{ id: 'o1', name: 'Team', slug: 'team', avatarUrl: null, role: 'ADMIN' }], orgById: (id: string) => id === 'o1' ? { id, name: 'Team', role: 'ADMIN' } : null }) }));
vi.mock('@/retained/components/common/PagePickerPopover', () => ({ PagePickerPopover: () => null }));
vi.mock('swr', () => ({ default: () => ({ data: { members: [{ userId: 'u1', source: 'lead', user: { id: 'u1', email: 'lead@example.com', name: 'Ada' } }] } }) }));
test('General composes the existing Organization ownership and billing card alongside native settings', () => {
  const markup = renderToStaticMarkup(<GeneralSettingsPage />);
  expect(markup).toContain('Organization');
  expect(markup).toContain('Team');
  expect(markup).toContain('Ada');
  expect(markup).toContain('Basic drive settings');
});

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

describe('organization and wallet native destinations', () => {
  test.each(['account/wallets', 'account/organizations', '[driveId]/settings/wallet', 'orgs/[orgId]/settings', 'orgs/[orgId]/settings/general', 'orgs/[orgId]/settings/members', 'orgs/[orgId]/settings/drives', 'orgs/[orgId]/settings/policies', 'orgs/[orgId]/settings/security', 'orgs/[orgId]/settings/billing', 'orgs/[orgId]/settings/audit', 'orgs/[orgId]/settings/attention', 'orgs/[orgId]/settings/danger', 'orgs/[orgId]/drives'])('%s has a destination in the authenticated shell', path => {
    expect(existsSync(join(__dirname, path, 'page.tsx'))).toBe(true);
  });
});

const getViewer = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/get-viewer', () => ({ getViewer }));
vi.mock('@/retained/app/settings/usage/wallets/page', () => ({ default: () => null }));
vi.mock('@/retained/app/dashboard/[driveId]/settings/wallet/page', () => ({ default: () => null }));
vi.mock('@/retained/components/orgs/AccountOrganizationsSection', () => ({ AccountOrganizationsSection: () => null }));
const entrypoints = [
  () => import('./account/wallets/page'),
  () => import('./account/organizations/page'),
  () => import('./[driveId]/settings/wallet/page'),
];
beforeEach(() => { getViewer.mockReset(); getViewer.mockResolvedValue({ userId: 'viewer' }); });
describe('entrypoint auth gates', () => {
  test.each(entrypoints)('renders its retained surface only after verifying the viewer', async load => {
    const { default: Page } = await load();
    const node = await Page({ params: Promise.resolve({ driveId: 'd1' }) });
    expect(getViewer).toHaveBeenCalledOnce();
    expect(node).not.toBeNull();
  });
  test.each(entrypoints)('propagates sign-in denial without rendering', async load => {
    const denial = new Error('sign in required');
    getViewer.mockRejectedValue(denial);
    const { default: Page } = await load();
    await expect(Page({ params: Promise.resolve({ driveId: 'd1' }) })).rejects.toBe(denial);
  });
});

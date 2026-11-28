import { describe, expect, it, vi } from 'vitest';

vi.mock('@/retained/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: true }) }));
vi.mock('@/retained/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ organizations: [] }) }));
vi.mock('@/retained/stores/useAuthStore', () => ({ useAuthStore: () => null }));
vi.mock('@/retained/lib/upload/orchestrator', () => ({ uploadFileToS3: vi.fn() }));

import { quotaDenial, type QuotaViewer } from '../useFileDrop';

const outOfSpace = (quota: Record<string, unknown>) => ({
  status: 413,
  body: { reason: 'Not enough storage space', requiredBytes: 200, quota: { availableBytes: 100, tier: 'pro', ...quota } },
});
const viewer = (over: Partial<QuotaViewer> = {}): QuotaViewer => ({ viewerId: 'me', adminOrgIds: new Set(['org-mine']), canBuy: true, ...over });

describe('quotaDenial', () => {
  it('links the payer to their own Storage screen, or the billing page of an org they run', () => {
    expect(quotaDenial(outOfSpace({ userId: 'me' }), viewer())).toEqual({ reason: 'Not enough storage space', manageHref: '/account/storage', contact: null });
    expect(quotaDenial(outOfSpace({ orgId: 'org-mine' }), viewer())?.manageHref).toBe('/orgs/org-mine/settings/billing');
  });

  it('tells a viewer who does not pay who to ask, and links nowhere', () => {
    const owners = quotaDenial(outOfSpace({ userId: 'drive-owner' }), viewer());
    expect(owners).toMatchObject({ manageHref: null });
    expect(owners?.contact).toMatch(/owner/);
    const org = quotaDenial(outOfSpace({ orgId: 'org-other' }), viewer());
    expect(org).toMatchObject({ manageHref: null });
    expect(org?.contact).toMatch(/Owner or Admin/);
  });

  it('offers no link where this client cannot sell storage', () => {
    expect(quotaDenial(outOfSpace({ userId: 'me' }), viewer({ canBuy: false }))).toMatchObject({ manageHref: null, contact: null });
  });

  it('a file over the per-file limit gets its reason only; anything but a 413 is not a quota denial', () => {
    expect(quotaDenial({ status: 413, body: { reason: 'File exceeds 20MB', requiredBytes: 200, quota: { availableBytes: 100, userId: 'me' } } }, viewer()))
      .toEqual({ reason: 'File exceeds 20MB', manageHref: null, contact: null });
    expect(quotaDenial({ status: 500, body: { reason: 'x' } }, viewer())).toBeNull();
  });
});

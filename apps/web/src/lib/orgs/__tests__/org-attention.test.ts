import { describe, it, expect } from 'vitest';
import { guestRequestCopy } from '../org-attention';
import type { GuestApproval } from '../org-api';

const item = (over: Partial<GuestApproval['request']> = {}, rest: Partial<GuestApproval> = {}): GuestApproval => ({
  holdId: 'h1', driveId: 'd', userId: 'u', email: 'nadia@fox.example', origin: 'drive_link', createdAt: '', driveName: 'Marketing Site', requesterName: 'Nadia Fox',
  request: { role: 'GUEST', customRoleId: null, pageGrants: 2, tokenScopes: 0, earliestExpiry: '2026-10-19T00:00:00Z', viaLink: true, ...over },
  ...rest,
});

describe('guestRequestCopy', () => {
  it('POL-2 (partial): shows exactly the access a guest would get (canvas OrgAttention)', () => {
    expect(guestRequestCopy(item())).toEqual({ who: 'Nadia Fox', wants: 'Wants View access in', facts: ['Pages: 2 pages', 'API token: none', 'Expires: Oct 19'], viaLink: true });
  });

  it('whole-drive requests with a token and no expiry', () => {
    const copy = guestRequestCopy(item({ role: 'MEMBER', pageGrants: 0, tokenScopes: 1, earliestExpiry: null, viaLink: false }));
    expect(copy.wants).toBe('Wants Member access in');
    expect(copy.facts).toEqual(['Pages: whole drive', 'API token: 1 scope', 'Expires: no expiry']);
  });

  it('falls back to the email when there is no name', () => {
    expect(guestRequestCopy(item({}, { requesterName: null })).who).toBe('nadia@fox.example');
  });
});

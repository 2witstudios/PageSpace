import { describe, it, expect } from 'vitest';
import { driveMembersLabel, VISIBILITY_COPY, movableDrives } from '../org-drives';

describe('driveMembersLabel', () => {
  it('UI-7 (partial): people in the drive, and how many are guests (canvas "12 · 1 guest")', () => {
    expect(driveMembersLabel({ memberCount: 12, guestCount: 1 })).toBe('12 · 1 guest');
    expect(driveMembersLabel({ memberCount: 5, guestCount: 2 })).toBe('5 · 2 guests');
    expect(driveMembersLabel({ memberCount: 3, guestCount: 0 })).toBe('3');
    expect(driveMembersLabel(undefined)).toBe('');
  });
});

describe('VISIBILITY_COPY', () => {
  it('DRV-4 (partial): explains Open, Restricted and Private as the canvas card does', () => {
    expect(Object.keys(VISIBILITY_COPY)).toEqual(['OPEN', 'RESTRICTED', 'PRIVATE']);
    expect(VISIBILITY_COPY.OPEN.label).toBe('Open');
    expect(VISIBILITY_COPY.RESTRICTED.description).toMatch(/drive lead approves/);
    expect(VISIBILITY_COPY.PRIVATE.description).toMatch(/audit log/);
  });
});

describe('movableDrives', () => {
  it('DRV-2 (partial): only personal drives I own and have not trashed can move in; Home never', () => {
    const drives = [
      { id: 'a', name: 'Side', isOwned: true, orgId: null, isTrashed: false, kind: 'STANDARD' as const },
      { id: 'h', name: 'Home', isOwned: true, orgId: null, isTrashed: false, kind: 'HOME' as const },
      { id: 'o', name: 'Org', isOwned: true, orgId: 'org', isTrashed: false },
      { id: 's', name: 'Shared', isOwned: false, orgId: null, isTrashed: false },
      { id: 't', name: 'Trash', isOwned: true, orgId: null, isTrashed: true },
    ];
    expect(movableDrives(drives).map((d) => d.id)).toEqual(['a']);
  });
});

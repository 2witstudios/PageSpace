import { describe, it, expect } from 'vitest';
import { decideDevPreviewManage } from '../manage-decision';

const ENV = { kind: 'env', id: 'e' } as const;
const WS = { kind: 'workspace', id: 'w' } as const;

describe('decideDevPreviewManage', () => {
  it('an ENV preview is owner/admin only — however the user reached it (session route included)', () => {
    expect(decideDevPreviewManage({ holder: ENV, userId: 'u', sessionOwnerId: 'u', isDriveOwnerOrAdmin: false })).toBe(false);
    expect(decideDevPreviewManage({ holder: ENV, userId: 'u', sessionOwnerId: null, isDriveOwnerOrAdmin: false })).toBe(false);
    expect(decideDevPreviewManage({ holder: ENV, userId: 'u', sessionOwnerId: null, isDriveOwnerOrAdmin: true })).toBe(true);
    expect(decideDevPreviewManage({ holder: ENV, userId: 'u', sessionOwnerId: 'other', isDriveOwnerOrAdmin: true })).toBe(true);
  });

  it('a SESSION preview is the session owner\'s — a drive admin who does not own it may not flip it', () => {
    expect(decideDevPreviewManage({ holder: WS, userId: 'u', sessionOwnerId: 'u', isDriveOwnerOrAdmin: false })).toBe(true);
    expect(decideDevPreviewManage({ holder: WS, userId: 'u', sessionOwnerId: 'other', isDriveOwnerOrAdmin: true })).toBe(false);
    expect(decideDevPreviewManage({ holder: WS, userId: 'u', sessionOwnerId: null, isDriveOwnerOrAdmin: true })).toBe(false);
  });
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: {} }));

import { decideAuthoringScope } from '../authoring-credential';

const ROWS = [{ driveId: 'drive_x', role: 'MEMBER' as const, customRoleId: null }];
const base = { runUserId: 'user_1', runUserActive: true };

describe('decideAuthoringScope — the ceiling a deferred run executes under', () => {
  it('no stored ceiling: the user authored it as themself — no ceiling, the run proceeds', () => {
    expect(decideAuthoringScope({ ...base, stored: null })).toEqual({ ok: true, scope: {} });
  });

  it('a live mcp_ key: its CURRENT drives and the key id', () => {
    expect(decideAuthoringScope({ ...base, stored: { kind: 'mcp', tokenId: 'tok_1' }, mcpKey: { userId: 'user_1', revoked: false, driveIds: ['drive_x'] } }))
      .toEqual({ ok: true, scope: { mcpAllowedDriveIds: ['drive_x'], credentialCeiling: { kind: 'mcp', tokenId: 'tok_1' } } });
  });

  it.each([
    ['revoked', { userId: 'user_1', revoked: true, driveIds: ['drive_x'] }],
    ['gone', null],
    ['another user\'s key', { userId: 'user_2', revoked: false, driveIds: ['drive_x'] }],
    ['a key left with no drives (it would read as unscoped)', { userId: 'user_1', revoked: false, driveIds: [] }],
  ])('an mcp_ key that is %s: refused', (_label, mcpKey) => {
    expect(decideAuthoringScope({ ...base, stored: { kind: 'mcp', tokenId: 'tok_1' }, mcpKey }).ok).toBe(false);
  });

  it('a live OAuth grant: its consented drives, rows and family', () => {
    const stored = { kind: 'oauth', driveScopes: ROWS, familyId: 'fam_1' };
    expect(decideAuthoringScope({ ...base, stored, oauthFamilyLive: true }))
      .toEqual({ ok: true, scope: { mcpAllowedDriveIds: ['drive_x'], credentialCeiling: stored } });
  });

  it.each([
    ['its family no longer live', { kind: 'oauth', driveScopes: ROWS, familyId: 'fam_1' }, false],
    ['no family to re-check', { kind: 'oauth', driveScopes: ROWS }, true],
    ['no drive rows (a profile-only shape)', { kind: 'oauth', driveScopes: [], familyId: 'fam_1' }, true],
  ])('an OAuth grant with %s: refused', (_label, stored, oauthFamilyLive) => {
    expect(decideAuthoringScope({ ...base, stored, oauthFamilyLive }).ok).toBe(false);
  });

  it('a suspended or missing run user: refused whatever the credential', () => {
    expect(decideAuthoringScope({ ...base, runUserActive: false, stored: { kind: 'mcp', tokenId: 'tok_1' }, mcpKey: { userId: 'user_1', revoked: false, driveIds: ['drive_x'] } }).ok).toBe(false);
  });

  it('an unreadable stored value fails closed', () => {
    expect(decideAuthoringScope({ ...base, stored: { kind: 'mcp' } }).ok).toBe(false);
    expect(decideAuthoringScope({ ...base, stored: { kind: 'session' } }).ok).toBe(false);
  });
});

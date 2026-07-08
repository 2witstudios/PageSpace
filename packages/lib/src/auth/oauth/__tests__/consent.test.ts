/**
 * Consent-screen narration (ADR 0002 Decision 5): parsed scopes + resolved
 * names in, human-readable strings out. Pure — no DB, no fetch; the caller
 * resolves driveName/roleName/roleSummary and passes them in.
 */
import { describe, it, expect } from 'vitest';
import { describeScopeForConsent } from '../consent';
import type { ParsedScope } from '../scopes';

describe('describeScopeForConsent', () => {
  it('flags `account` as the maximum, full-account grant', () => {
    const text = describeScopeForConsent({ kind: 'account' }, {});
    expect(text).toMatch(/full access/i);
    expect(text).toMatch(/account/i);
  });

  it('describes offline_access as a long-lived refresh credential', () => {
    const text = describeScopeForConsent({ kind: 'offline_access' }, {});
    expect(text).toMatch(/revoke/i);
  });

  it('describes an inherit drive scope by the resolved drive name, not the raw id', () => {
    const scope: ParsedScope = { kind: 'drive', driveId: 'drv123', role: { kind: 'inherit' } };
    const text = describeScopeForConsent(scope, { driveName: 'Marketing' });
    expect(text).toMatch(/Marketing/);
    expect(text).not.toMatch(/drv123$/); // id may appear as a suffix/tooltip, never standalone
    expect(text).toMatch(/act as you/i);
  });

  it('describes an admin drive scope, explicitly naming private-page access', () => {
    const scope: ParsedScope = { kind: 'drive', driveId: 'drv123', role: { kind: 'admin' } };
    const text = describeScopeForConsent(scope, { driveName: 'Marketing' });
    expect(text).toMatch(/admin/i);
    expect(text).toMatch(/private/i);
    expect(text).toMatch(/Marketing/);
  });

  it('describes a plain member drive scope as view + channel-post only', () => {
    const scope: ParsedScope = { kind: 'drive', driveId: 'drv123', role: { kind: 'member' } };
    const text = describeScopeForConsent(scope, { driveName: 'Marketing' });
    expect(text).toMatch(/member/i);
    expect(text).toMatch(/cannot edit/i);
    expect(text).toMatch(/Marketing/);
  });

  it('describes manage_keys as key-management access with no content access', () => {
    const text = describeScopeForConsent({ kind: 'manage_keys' }, {});
    expect(text).toMatch(/manage/i);
    expect(text).toMatch(/keys/i);
    expect(text).toMatch(/cannot read or write/i);
  });

  it('describes all_drives as the maximum grant for a drive-scoped key', () => {
    const text = describeScopeForConsent({ kind: 'all_drives' }, {});
    expect(text).toMatch(/all your drives/i);
    expect(text).toMatch(/created later/i);
  });

  it('describes a custom-role drive scope by resolved role name + summary', () => {
    const scope: ParsedScope = { kind: 'drive', driveId: 'drv123', role: { kind: 'custom', customRoleId: 'role1' } };
    const text = describeScopeForConsent(scope, {
      driveName: 'Marketing',
      roleName: 'Editor',
      roleSummary: 'can edit pages, cannot delete',
    });
    expect(text).toMatch(/Editor/);
    expect(text).toMatch(/Marketing/);
    expect(text).toMatch(/can edit pages, cannot delete/);
  });

  it('describes update_key as an in-place re-scope of a named existing key with an unchanged secret', () => {
    const scope: ParsedScope = { kind: 'update_key', tokenId: 'tok123' };
    const text = describeScopeForConsent(scope, { keyName: 'CI agent key' });
    expect(text).toMatch(/CI agent key/);
    expect(text).toMatch(/existing key/i);
    expect(text).toMatch(/secret stay/i);
    expect(text).not.toMatch(/tok123/);
  });

  it('falls back to the token id when no key name is resolved for update_key', () => {
    const text = describeScopeForConsent({ kind: 'update_key', tokenId: 'tok123' }, {});
    expect(text).toMatch(/tok123/);
  });
});

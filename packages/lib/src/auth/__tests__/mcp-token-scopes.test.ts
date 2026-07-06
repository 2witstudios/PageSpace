import { describe, it, expect } from 'vitest';
import { normalizeDriveScopes, computeMcpTokenActionBinding, type DriveScopeInput } from '../mcp-token-scopes';

describe('normalizeDriveScopes', () => {
 it('returns empty array when both inputs are undefined', () => {
   expect(normalizeDriveScopes()).toEqual([]);
 });

 it('returns empty array when both inputs are empty arrays', () => {
   expect(normalizeDriveScopes([], [])).toEqual([]);
 });

 it('throws when both drives and driveIds are provided', () => {
   expect(() =>
     normalizeDriveScopes(
       [{ id: 'drive-1', role: 'ADMIN' }],
       ['drive-2']
     )
   ).toThrow(/mutually exclusive/i);
 });

 it('maps driveIds to scopes with null role (inherit)', () => {
   const result = normalizeDriveScopes(undefined, ['drive-1', 'drive-2']);
   expect(result).toEqual([
     { id: 'drive-1', role: null, customRoleId: undefined },
     { id: 'drive-2', role: null, customRoleId: undefined },
   ]);
 });

 it('passes drives through with defaults for missing fields', () => {
   const result = normalizeDriveScopes([
     { id: 'drive-1', role: 'ADMIN' },
     { id: 'drive-2', role: null, customRoleId: 'role-1' },
   ]);
   expect(result).toEqual([
     { id: 'drive-1', role: 'ADMIN', customRoleId: undefined },
     { id: 'drive-2', role: null, customRoleId: 'role-1' },
   ]);
 });

 it('deduplicates drive IDs (last wins)', () => {
   const result = normalizeDriveScopes([
     { id: 'drive-1', role: 'MEMBER' },
     { id: 'drive-1', role: 'ADMIN' },
   ]);
   expect(result).toEqual([
     { id: 'drive-1', role: 'ADMIN', customRoleId: undefined },
   ]);
 });

 it('deduplicates driveIds (last wins)', () => {
   const result = normalizeDriveScopes(undefined, ['drive-1', 'drive-1']);
   expect(result).toEqual([
     { id: 'drive-1', role: null, customRoleId: undefined },
   ]);
 });

 it('handles mixed role + customRoleId from drives input', () => {
   const result = normalizeDriveScopes([
     { id: 'd1', role: 'ADMIN', customRoleId: undefined },
     { id: 'd2', role: 'MEMBER', customRoleId: 'cr-1' },
     { id: 'd3', role: null, customRoleId: 'cr-2' },
   ]);
   expect(result).toHaveLength(3);
   expect(result[0]).toEqual({ id: 'd1', role: 'ADMIN', customRoleId: undefined });
   expect(result[1]).toEqual({ id: 'd2', role: 'MEMBER', customRoleId: 'cr-1' });
   expect(result[2]).toEqual({ id: 'd3', role: null, customRoleId: 'cr-2' });
 });
});

describe('computeMcpTokenActionBinding', () => {
  it('is independent of drive array order', () => {
    const a = computeMcpTokenActionBinding({
      name: 'My Token',
      driveScopes: normalizeDriveScopes([{ id: 'drive-1', role: 'ADMIN' }, { id: 'drive-2', role: 'MEMBER' }]),
    });
    const b = computeMcpTokenActionBinding({
      name: 'My Token',
      driveScopes: normalizeDriveScopes([{ id: 'drive-2', role: 'MEMBER' }, { id: 'drive-1', role: 'ADMIN' }]),
    });
    expect(a).toEqual(b);
  });

  it('changes when the token name changes', () => {
    const driveScopes = normalizeDriveScopes([{ id: 'drive-1', role: 'ADMIN' }]);
    const a = computeMcpTokenActionBinding({ name: 'Token A', driveScopes });
    const b = computeMcpTokenActionBinding({ name: 'Token B', driveScopes });
    expect(a).not.toEqual(b);
  });

  it('changes when a drive role changes', () => {
    const a = computeMcpTokenActionBinding({
      name: 'My Token',
      driveScopes: normalizeDriveScopes([{ id: 'drive-1', role: 'ADMIN' }]),
    });
    const b = computeMcpTokenActionBinding({
      name: 'My Token',
      driveScopes: normalizeDriveScopes([{ id: 'drive-1', role: 'MEMBER' }]),
    });
    expect(a).not.toEqual(b);
  });

  it('produces the same binding for equivalent legacy driveIds and drives input', () => {
    const a = computeMcpTokenActionBinding({
      name: 'My Token',
      driveScopes: normalizeDriveScopes(undefined, ['drive-1']),
    });
    const b = computeMcpTokenActionBinding({
      name: 'My Token',
      driveScopes: normalizeDriveScopes([{ id: 'drive-1', role: null }]),
    });
    expect(a).toEqual(b);
  });

  it('does not collide two different drive-scope sets when a customRoleId smuggles a delimiter sequence', () => {
    // Regression: with an unescaped `${id}:${role}:${customRoleId}` join,
    // both of these serialized to "x::y,z:MEMBER:" — letting a step-up grant
    // minted for one drive-scope set be spent minting a different one.
    const a = computeMcpTokenActionBinding({
      name: 'Token',
      driveScopes: normalizeDriveScopes([{ id: 'x', role: null, customRoleId: 'y,z:MEMBER:' }]),
    });
    const b = computeMcpTokenActionBinding({
      name: 'Token',
      driveScopes: normalizeDriveScopes([
        { id: 'x', role: null, customRoleId: 'y' },
        { id: 'z', role: 'MEMBER' },
      ]),
    });
    expect(a).not.toEqual(b);
  });
});

import { describe, it, expect } from 'vitest';
import { normalizeDriveScopes, type DriveScopeInput } from '../mcp-token-scopes';

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

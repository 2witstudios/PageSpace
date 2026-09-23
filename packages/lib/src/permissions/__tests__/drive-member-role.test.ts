import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DRIVE_MEMBERSHIP_ROLES, driveMembershipRole, driveMembershipRow } from '../drive-member-role';

const LIB_SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'test' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('driveMembershipRole', () => {
  it('maps each membership role to itself', () => {
    expect(driveMembershipRole('OWNER')).toBe('OWNER');
    expect(driveMembershipRole('ADMIN')).toBe('ADMIN');
    expect(driveMembershipRole('MEMBER')).toBe('MEMBER');
  });

  it('D-OW-24 a GUEST row (a redeemed page share link) is no drive membership', () => {
    expect(driveMembershipRole('GUEST')).toBeNull();
  });

  it('throws on a role nobody classified, so a new enum value can never pass as a membership', () => {
    expect(() => driveMembershipRole('VIEWER')).toThrow(/Unknown drive member role "VIEWER"/);
    expect(() => driveMembershipRole('')).toThrow(/Unknown drive member role/);
    expect(() => driveMembershipRole('toString')).toThrow(/Unknown drive member role/);
  });

  it('the membership roles are exactly OWNER, ADMIN and MEMBER', () => {
    expect(DRIVE_MEMBERSHIP_ROLES).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
  });

  it('D-OW-24 driveMembershipRow reads a GUEST row as no membership, and a membership row as itself', () => {
    expect(driveMembershipRow({ role: 'GUEST', customRoleId: 'role-x', source: 'invite' })).toBeNull();
    expect(driveMembershipRow(undefined)).toBeNull();
    expect(driveMembershipRow({ role: 'MEMBER', customRoleId: 'role-x', source: 'org' }))
      .toEqual({ role: 'MEMBER', customRoleId: 'role-x', source: 'org' });
  });

  it('no lib source casts a stored role to DriveMemberRole: every read goes through driveMembershipRole', () => {
    const casts = sourceFiles(LIB_SRC)
      .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').map((line, i) => ({ file, line: i + 1, text: line })))
      .filter(({ text }) => /\bas\s+DriveMemberRole\b/.test(text))
      .map(({ file, line }) => `${path.relative(LIB_SRC, file)}:${line}`);
    expect(casts).toEqual([]);
  });
});

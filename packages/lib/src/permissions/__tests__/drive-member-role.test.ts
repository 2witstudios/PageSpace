import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logging/logger-config', () => ({
  loggers: { api: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { loggers } from '../../logging/logger-config';
import { DRIVE_MEMBERSHIP_ROLES, driveMembershipRole, driveMembershipRow } from '../drive-member-role';
import { isGuestRole } from '../guest-role';
import { memberRole } from '@pagespace/db/schema/members';

beforeEach(() => vi.mocked(loggers.api.warn).mockClear());

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

  it('D-OW-24 agrees with master\'s isGuestRole on every value of the MemberRole enum: a role is no membership exactly when it is GUEST', () => {
    // The enum as the database defines it (master's 0308 added GUEST): nothing is left out.
    expect([...memberRole.enumValues].sort()).toEqual(['ADMIN', 'GUEST', 'MEMBER', 'OWNER']);
    for (const role of memberRole.enumValues) {
      expect(driveMembershipRole(role) === null, role).toBe(isGuestRole(role));
    }
    expect(loggers.api.warn).not.toHaveBeenCalled();
  });

  it('fails closed on a role nobody classified: no membership and a warning, never a throw', () => {
    expect(driveMembershipRole('VIEWER')).toBeNull();
    expect(driveMembershipRole('')).toBeNull();
    expect(driveMembershipRole('toString')).toBeNull();
    expect(loggers.api.warn).toHaveBeenCalledTimes(3);
    expect(loggers.api.warn).toHaveBeenCalledWith(
      expect.stringContaining('Unclassified drive member role'),
      expect.objectContaining({ role: 'VIEWER' }),
    );
  });

  it('fails closed on a row with no role at all: no membership and a warning', () => {
    expect(driveMembershipRole(undefined)).toBeNull();
    expect(driveMembershipRole(null)).toBeNull();
    expect(loggers.api.warn).toHaveBeenCalledTimes(2);
  });

  it('a classified role logs nothing, GUEST included (it is expected data, not an anomaly)', () => {
    driveMembershipRole('MEMBER');
    driveMembershipRole('GUEST');
    expect(loggers.api.warn).not.toHaveBeenCalled();
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

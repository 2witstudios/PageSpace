import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * D-OW-24: a GUEST row (a redeemed page share link) is no drive membership. The GUEST enum value
 * does not exist on this branch yet, so no real row can be written; these tests pin the SQL and the
 * row filter that keep a GUEST out once it does. The real-database parity with listMemberDrives is
 * drive-gate-primitives.integration.test.ts.
 */

let orgsEnabled = false;
vi.mock('../../organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return orgsEnabled;
  },
}));

import { users } from '@pagespace/db/schema/auth';
import { memberOfAnyDriveCondition } from '../member-drives';
import { loadAcceptedDriveMemberPairs } from '../org-drive-membership';

const render = () => new PgDialect().sqlToQuery(memberOfAnyDriveCondition(users.id, ['drive-product']));

/** Each EXISTS over drive_members must carry `"drive_members"."role" in (OWNER, ADMIN, MEMBER)`. */
function driveMembersExistsClauses(sqlText: string): string[] {
  return sqlText.split(/exists \(/i).slice(1).filter((clause) => /from "drive_members"/.test(clause.split(/exists \(/i)[0]));
}

describe('memberOfAnyDriveCondition never counts a GUEST row', () => {
  beforeEach(() => {
    orgsEnabled = false;
  });

  it('D-OW-24 while dark, the accepted-row EXISTS admits only membership roles', () => {
    const { sql, params } = render();
    const clauses = driveMembersExistsClauses(sql);
    expect(clauses).toHaveLength(1);
    expect(clauses[0]).toMatch(/"drive_members"\."role" in \(\$\d+, \$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['OWNER', 'ADMIN', 'MEMBER']));
    expect(params).not.toContain('GUEST');
  });

  it('D-OW-24 with orgs on, the valid-row EXISTS admits only membership roles', () => {
    orgsEnabled = true;
    const { sql, params } = render();
    const clauses = driveMembersExistsClauses(sql);
    expect(clauses).toHaveLength(1);
    expect(clauses[0]).toMatch(/"drive_members"\."role" in \(\$\d+, \$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['OWNER', 'ADMIN', 'MEMBER']));
  });
});

describe('loadAcceptedDriveMemberPairs never counts a GUEST row', () => {
  it('D-OW-24 a GUEST pair is not "still on the drive" for org deletion; a member pair is', async () => {
    const rows = [
      { userId: 'user-lena', driveId: 'drive-product', role: 'MEMBER' },
      { userId: 'user-chris', driveId: 'drive-product', role: 'GUEST' },
    ];
    const executor = {
      select: () => ({ from: () => ({ where: async () => rows }) }),
    } as unknown as Parameters<typeof loadAcceptedDriveMemberPairs>[0];

    expect(await loadAcceptedDriveMemberPairs(executor, ['user-lena', 'user-chris'], ['drive-product']))
      .toEqual([{ userId: 'user-lena', driveId: 'drive-product' }]);
  });
});

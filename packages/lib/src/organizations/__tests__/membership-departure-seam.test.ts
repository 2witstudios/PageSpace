/**
 * SEC-1's re-join guard reads org_member_departures, which leaveOrganization writes in the same
 * transaction as the membership delete. That only holds if leaveOrganization is the ONE place an
 * org_members row is deleted: removal (removeMember), choosing to leave, and account deletion
 * (leaveAllOrganizations) all go through it. Deleting the org or the user cascades instead; the person
 * or the org is then gone with the record. A new direct delete anywhere else fails here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO = path.resolve(__dirname, '../../../../..');
const ROOTS = ['packages/lib/src', 'apps'];
const DELETES_ORG_MEMBER = /\.delete\(\s*orgMembers\b|DELETE\s+FROM\s+"?org_members"?/i;
const THE_ONE_DELETER = 'packages/lib/src/organizations/leave.ts';

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.next', '__tests__'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('the one way a membership ends', () => {
  it('SEC-1 (partial) only leaveOrganization deletes an org_members row, so every departure is recorded for the re-join guard', () => {
    const deleters = ROOTS.flatMap((root) => sources(path.join(REPO, root)))
      .filter((file) => DELETES_ORG_MEMBER.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO, file));
    expect(deleters).toEqual([THE_ONE_DELETER]);
    const leave = fs.readFileSync(path.join(REPO, THE_ONE_DELETER), 'utf8');
    expect(leave).toMatch(/\.insert\(orgMemberDepartures\)/);
  });
});

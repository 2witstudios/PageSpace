/**
 * L2·G2 review LOW-2 — who may see an agent page's account LIST, decided from
 * the caller's standing on the page alone, before any row is read, so the
 * answer cannot reveal whether the page has accounts. Same bar as `view` on an
 * agent-page-owned account (ADR 0004 §4.1): a drive OWNER/ADMIN, or a member
 * who can edit the page.
 */
import { describe, expect, it } from 'vitest';
import { decideAccountListView } from '../decide-account-list-view';

describe('decideAccountListView', () => {
  it('given each drive role and page permission, should allow owners, admins and editing members only', () => {
    const cases = [
      ['OWNER', 'none'],
      ['ADMIN', 'view'],
      ['MEMBER', 'edit'],
      ['MEMBER', 'view'],
      [null, 'edit'],
      [null, 'none'],
    ] as const;
    const actual = cases.map(([humanDriveRole, pagePermission]) => decideAccountListView({ humanDriveRole, pagePermission }));
    const expected = [true, true, true, false, false, false];
    expect(actual).toEqual(expected);
  });
});

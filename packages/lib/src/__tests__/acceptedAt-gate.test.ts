/**
 * acceptedAt Authz Gate — packages/lib structural coverage
 *
 * The Epic 1 hardening composes `isNotNull(driveMembers.acceptedAt)` into
 * every authorization query that reads `drive_members`. These tests pin that
 * structure into source so a future contributor cannot silently remove the
 * gate from any covered function.
 *
 * Why structural source assertions instead of behavioural mocks: the existing
 * service code calls Drizzle's query-builder chain directly. Mocking that
 * chain per-test couples tests to query order and shape (which is exactly the
 * brittle pattern Epic 2 will retire). A structural read of the source
 * proves the gate is composed into the right WHERE clause without inventing a
 * fake DB. The seam will move to a repository in Epic 2; these tests stay
 * useful as long as the source has the function name they pin to.
 *
 * Each `it(...)` names the regression it catches.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf-8');
}

/**
 * Extract the body of a top-level exported async function by name.
 * Returns the substring from the function declaration up to the next
 * top-level `export ` token (or end-of-file).
 */
function extractFunctionBody(source: string, fnName: string): string {
  const start = source.indexOf(`export async function ${fnName}`);
  if (start === -1) {
    throw new Error(`Function not found: ${fnName}`);
  }
  // Find next top-level export (function, const, etc.) after the declaration.
  const restAfterStart = source.slice(start + 1);
  const nextExportRel = restAfterStart.search(/\nexport (async function|function|const|interface|type)/);
  const end = nextExportRel === -1 ? source.length : start + 1 + nextExportRel;
  return source.slice(start, end);
}

const GATE = /isNotNull\s*\(\s*driveMembers\.acceptedAt\s*\)/;
/** Reads membership through the shared org-aware loader, whose lookup carries GATE. */
const DELEGATES = /loadEffectiveDriveMembership\(/;

describe('drive-member-service.ts', () => {
  const source = read('services/drive-member-service.ts');

  // checkDriveAccess resolves membership through loadEffectiveDriveMembership (org access, B7b),
  // whose own drive_members lookup carries the gate: pinned in the org-drive-membership.ts block.
  it('given a non-owner caller, checkDriveAccess membership lookup gates pending rows (regression: pending row would otherwise grant isMember=true)', () => {
    const body = extractFunctionBody(source, 'checkDriveAccess');
    expect(body).toMatch(DELEGATES);
    expect(body).not.toMatch(/\.from\(driveMembers\)/);
  });

  it('given a non-owner caller, checkDriveAccess membership lookup must not grant ADMIN to pending rows (regression: pending admin would otherwise pass isAdmin=true)', () => {
    const body = extractFunctionBody(source, 'checkDriveAccess');
    expect(body).toMatch(DELEGATES);
    expect(body).toMatch(/role\s*===\s*'ADMIN'/);
  });

  it('getDriveMemberUserIds gates pending rows out of authz member lists (regression: pending row would surface in authz allow-lists)', () => {
    const body = extractFunctionBody(source, 'getDriveMemberUserIds');
    expect(body).toMatch(GATE);
  });

  it('getDriveRecipientUserIds gates pending rows out of broadcast recipient sets (regression: pending member would receive realtime events for a drive they have not accepted)', () => {
    const body = extractFunctionBody(source, 'getDriveRecipientUserIds');
    expect(body).toMatch(GATE);
  });

  it('isMemberOfDrive returns false for pending rows (regression: pending row would pass membership check)', () => {
    const body = extractFunctionBody(source, 'isMemberOfDrive');
    expect(body).toMatch(GATE);
  });

  it('owners (drive.ownerId) bypass membership lookup so the gate cannot lock them out (regression: gate must not affect drive owners)', () => {
    const body = extractFunctionBody(source, 'checkDriveAccess');
    expect(body).toMatch(/drive\.ownerId\s*===\s*userId/);
    expect(body).toMatch(/isOwner: true, isAdmin: true, isMember: true/);
  });
});

describe('drive-service.ts', () => {
  const source = read('services/drive-service.ts');

  it('listAccessibleDrives memberDrives query gates pending rows (regression: pending member would see drive in their accessible-drives list)', () => {
    const body = extractFunctionBody(source, 'listAccessibleDrives');
    expect(body).toMatch(GATE);
  });

  // Both resolve membership through loadEffectiveDriveMembership (org access, Wave B7), whose own
  // drive_members lookup carries the gate: pinned in the permissions/org-drive-membership.ts block.
  it('getDriveAccess non-owner branch gates pending rows (regression: pending row would return isMember=true through the bare access lookup)', () => {
    const body = extractFunctionBody(source, 'getDriveAccess');
    expect(body).toMatch(/loadEffectiveDriveMembership\(/);
    expect(body).not.toMatch(/\.from\(driveMembers\)/);
  });

  it('getDriveAccessWithDrive non-owner branch gates pending rows (regression: bundled lookup would surface pending row as a member)', () => {
    const body = extractFunctionBody(source, 'getDriveAccessWithDrive');
    expect(body).toMatch(/loadEffectiveDriveMembership\(/);
    expect(body).not.toMatch(/\.from\(driveMembers\)/);
  });

  describe('updateDriveLastAccessed (Slice 1.3 owner self-heal)', () => {
    const body = extractFunctionBody(source, 'updateDriveLastAccessed');

    it('given a legacy owner row with acceptedAt IS NULL, sets acceptedAt = now() via COALESCE on conflict (regression: gate would otherwise hide the owner from authz queries)', () => {
      expect(body).toMatch(/onConflictDoUpdate/);
      expect(body).toMatch(/acceptedAt:\s*sql`COALESCE\(\$\{driveMembers\.acceptedAt\},\s*\$\{now\}\)`/);
    });

    it('given the owner has no drive_members row at all, inserts one with acceptedAt = now() and role = OWNER (regression: missing row plus gate would lock the owner out)', () => {
      expect(body).toMatch(/role:\s*'OWNER'/);
      expect(body).toMatch(/acceptedAt:\s*now/);
      expect(body).toMatch(/\.insert\(driveMembers\)/);
    });

    it('given a non-owner with acceptedAt IS NULL, only updates lastAccessedAt — never touches acceptedAt (regression: auto-accepting pending invitations on any drive access would defeat the invite flow)', () => {
      // The non-owner path is the .update() branch. Capture it specifically by
      // looking at the section AFTER the owner-branch return.
      const ownerReturn = body.indexOf('return;');
      expect(ownerReturn).toBeGreaterThan(-1);
      const nonOwnerSection = body.slice(ownerReturn);
      expect(nonOwnerSection).toMatch(/\.update\(driveMembers\)/);
      expect(nonOwnerSection).toMatch(/lastAccessedAt:\s*now/);
      expect(nonOwnerSection).not.toMatch(/acceptedAt/);
    });
  });
});

describe('permissions/permissions.ts', () => {
  const source = read('permissions/permissions.ts');

  it('getDriveIdsForUser memberDrives query gates pending rows (regression: pending member drives would appear in the access-list used by callers like search and pulse)', () => {
    const body = extractFunctionBody(source, 'getDriveIdsForUser');
    expect(body).toMatch(GATE);
    // The org-aware body (ORGS_ENABLED) reads its own rows with the same gate.
    const start = source.indexOf('async function getDriveIdsForUserWithOrgs');
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, source.indexOf('\n}\n', start))).toMatch(GATE);
  });

  it.each([
    'isDriveOwnerOrAdmin',
    'isUserDriveMember',
    'getUserAccessiblePagesInDrive',
    'getUserAccessiblePagesInDriveWithDetails',
    'getUserDriveAccess',
    'getUserDrivePermissions',
  ])('%s reads membership only through the shared loader (regression: a local drive_members read could skip the pending-row gate or the org rules)', (fn) => {
    const body = extractFunctionBody(source, fn);
    expect(body).toMatch(DELEGATES);
    expect(body).not.toMatch(/\.from\(driveMembers\)/);
  });

  it.each(['getBatchPagePermissions', 'getUsersWhoCanViewPage'])('%s joins only accepted rows (regression: a pending row would reach the effective-membership pass)', (fn) => {
    const body = extractFunctionBody(source, fn);
    expect(body).toMatch(GATE);
    expect(body).toMatch(/withEffectiveMembership\(/);
  });
});

describe('permissions/org-drive-membership.ts', () => {
  const source = read('permissions/org-drive-membership.ts');

  it('loadEffectiveDriveMembership gates pending rows (regression: getUserAccessLevel, getDriveAccess and getDriveAccessWithDrive all read membership through it, so a pending row would open the drive)', () => {
    const body = extractFunctionBody(source, 'loadEffectiveDriveMembership');
    expect(body).toMatch(/\.from\(driveMembers\)/);
    expect(body).toMatch(GATE);
  });

  it('loadExplicitScopeAuthority gates pending rows (regression: a pending invited row on an org drive would back an explicit-role token scope)', () => {
    const body = extractFunctionBody(source, 'loadExplicitScopeAuthority');
    expect(body).toMatch(/\.from\(driveMembers\)/);
    expect(body).toMatch(GATE);
  });
});

describe('permissions/permission-mutations.ts', () => {
  const source = read('permissions/permission-mutations.ts');

  it('getPageIfCanShare admin-membership lookup gates pending rows (regression: pending admin would be able to grant or revoke share on pages in the drive they have not accepted)', () => {
    // getPageIfCanShare is module-private; locate by name.
    const start = source.indexOf('async function getPageIfCanShare');
    expect(start).toBeGreaterThan(-1);
    const restAfterStart = source.slice(start + 1);
    const nextExportRel = restAfterStart.search(/\n(export |async function )/);
    const end = nextExportRel === -1 ? source.length : start + 1 + nextExportRel;
    const body = source.slice(start, end);

    // The creator and admin branches both read the one shared membership (B7b), gated there.
    expect(body).toMatch(DELEGATES);
    expect(body).not.toMatch(/\.from\(driveMembers\)/);
    expect(body).toMatch(/membership\?\.role === 'ADMIN'/);
  });
});

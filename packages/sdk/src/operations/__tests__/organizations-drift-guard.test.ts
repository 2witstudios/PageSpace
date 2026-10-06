/**
 * Drift guard for the org vocabularies inlined in `operations/organizations.ts` (the
 * published SDK never runtime- or type-imports `@pagespace/lib`). Same pattern as
 * `wallets-drift-guard.test.ts`: test-only TYPE imports from lib's exported subpaths,
 * checked at compile time by `AssertExact` (the SDK's `typecheck` fails on drift).
 */
import { describe, expect, it } from 'vitest';
import type { OrgMemberDetail, OrgSummaryForUser } from '@pagespace/lib/organizations/repository';
import type { OrgPolicies } from '@pagespace/lib/organizations/policies-core';
import type { OrgDriveDirectoryEntry } from '@pagespace/lib/permissions/org-drive-directory';
import { getOrgPolicies, getOrganization, listMyOrganizations, listOrgDriveDirectory } from '../organizations.js';

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type SdkRole = (typeof listMyOrganizations.outputSchema)['_output']['organizations'][number]['role'];
type SdkVisibility = (typeof listOrgDriveDirectory.outputSchema)['_output']['drives'][number]['orgVisibility'];
type SdkPolicies = (typeof getOrgPolicies.outputSchema)['_output']['policies'];
type SdkDirectory = (typeof listOrgDriveDirectory.outputSchema)['_output']['drives'][number];

// The org role and drive visibility vocabularies are lib's, verbatim.
const roleIdentical: AssertExact<SdkRole, OrgSummaryForUser['role']> = true;
const memberRoleIdentical: AssertExact<SdkRole, OrgMemberDetail['role']> = true;
const viewerRoleIdentical: AssertExact<SdkRole, (typeof getOrganization.outputSchema)['_output']['viewer']['role']> = true;
const visibilityIdentical: AssertExact<SdkVisibility, OrgDriveDirectoryEntry['orgVisibility']> = true;
// The policy object is lib's `OrgPolicies`, key for key and type for type.
const policiesIdentical: AssertExact<SdkPolicies, OrgPolicies> = true;
// The directory entry's decision fields are lib's `DirectoryEntry` (extends into `OrgDriveDirectoryEntry`).
const joinedIdentical: AssertExact<SdkDirectory['joined'], OrgDriveDirectoryEntry['joined']> = true;
const joinRequestIdentical: AssertExact<SdkDirectory['joinRequest'], OrgDriveDirectoryEntry['joinRequest']> = true;
const canRequestIdentical: AssertExact<SdkDirectory['canRequest'], OrgDriveDirectoryEntry['canRequest']> = true;

describe('operations/organizations.ts — drift guard vs @pagespace/lib canonical shapes', () => {
  it('X-1 (partial) org roles, drive visibilities and the member/directory fields match lib (compile-time above)', () => {
    expect([roleIdentical, memberRoleIdentical, viewerRoleIdentical, visibilityIdentical, joinedIdentical, joinRequestIdentical, canRequestIdentical]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('X-1 (partial) the policy schema carries every key of lib OrgPolicies, same types', () => {
    expect(policiesIdentical).toBe(true);
    const keys = Object.keys(getOrgPolicies.outputSchema.shape.policies.shape);
    expect(keys.length).toBeGreaterThanOrEqual(17);
  });
});

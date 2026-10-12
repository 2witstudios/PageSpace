/**
 * Drift guard for the org vocabularies inlined in `operations/organizations.ts` (the
 * published SDK never runtime- or type-imports `@pagespace/lib`). Same pattern as
 * `wallets-drift-guard.test.ts`: test-only TYPE imports from lib's exported subpaths,
 * checked at compile time by `AssertExact` (the SDK's `typecheck` fails on drift).
 */
import { describe, expect, it } from 'vitest';
import type { OrgMemberDetail, OrgSummaryForUser } from '@pagespace/lib/organizations/repository';
import type { OrgPolicies, OrgPoliciesPatch, SuspensionKind } from '@pagespace/lib/organizations/policies-core';
import type { OrgDriveDirectoryEntry } from '@pagespace/lib/permissions/org-drive-directory';
import type { SuspendedResourceType } from '@pagespace/lib/organizations/policy-suspension';
import type { OrgAuditCategory } from '@pagespace/lib/audit/org-audit-query-core';
import type { AutomationKind } from '@pagespace/lib/organizations/automation-ownership';
import type { OrgDriveUsage, OrgGuestSource, OrgMemberActivity, OrgTrashedDrive } from '@pagespace/lib/permissions/org-read-models';
import type { PendingGuestApprovalView } from '@pagespace/lib/permissions/guest-holds';
import type { PublicOrgDomain } from '@pagespace/lib/organizations/domains';
import type { ImplicitMembersChoice } from '@pagespace/lib/organizations/org-drive-ownership';
import type { JoinRequestAnswerResult, PendingJoinRequest, RequestToJoinResult } from '@pagespace/lib/services/drive-join-request-service';
import {
  changeOrgMemberRole,
  deleteOrgAutomation,
  getOrgAuditLog,
  getOrgDriveUsage,
  getOrgPolicies,
  getOrganization,
  listMyOrganizations,
  listOrgDomains,
  listOrgDriveDirectory,
  listOrgGuestApprovals,
  listOrgGuests,
  listOrgMemberActivity,
  listOrgPolicySuspensions,
  listOrgTrashedDrives,
  updateOrgPolicies,
} from '../organizations.js';
import { answerDriveJoinRequest, createDrive, listDriveJoinRequests, listDrives, moveDriveOutOfOrg, requestToJoinDrive } from '../drives.js';

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

// ---------------------------------------------------------------------------
// The org writes, admin reads and drive-org operations (X-1)
// ---------------------------------------------------------------------------

type SdkInput<T extends { inputSchema: { _input: unknown } }> = T['inputSchema']['_input'];
type SdkOutput<T extends { outputSchema: { _output: unknown } }> = T['outputSchema']['_output'];

// A role change or invite grants anything but OWNER (ownership moves only by transfer).
const grantableIdentical: AssertExact<SdkInput<typeof changeOrgMemberRole>['role'], Exclude<OrgMemberDetail['role'], 'OWNER'>> = true;
// A policy change names exactly lib's OrgPoliciesPatch keys, besides the org id.
const patchKeysIdentical: AssertExact<Exclude<keyof SdkInput<typeof updateOrgPolicies>, 'orgId'>, keyof OrgPoliciesPatch> = true;
const suspensionKindIdentical: AssertExact<SdkOutput<typeof listOrgPolicySuspensions>['suspended'][number]['kind'], SuspensionKind> = true;
const resourceTypeIdentical: AssertExact<SdkOutput<typeof listOrgPolicySuspensions>['suspended'][number]['resourceType'], SuspendedResourceType> = true;
const auditCategoryIdentical: AssertExact<NonNullable<SdkInput<typeof getOrgAuditLog>['category']>, OrgAuditCategory> = true;
const automationKindIdentical: AssertExact<SdkInput<typeof deleteOrgAutomation>['kind'], AutomationKind> = true;
const guestSourceIdentical: AssertExact<SdkOutput<typeof listOrgGuests>['guests'][number]['drives'][number]['source'], OrgGuestSource> = true;
const holdOriginIdentical: AssertExact<SdkOutput<typeof listOrgGuestApprovals>['items'][number]['origin'], PendingGuestApprovalView['origin']> = true;
const verifiedMethodIdentical: AssertExact<SdkOutput<typeof listOrgDomains>['domains'][number]['verifiedMethod'], PublicOrgDomain['verifiedMethod']> = true;
// Read-model rows carry lib's keys, no more and no fewer.
const usageKeysIdentical: AssertExact<keyof SdkOutput<typeof getOrgDriveUsage>['usage'][number], keyof OrgDriveUsage> = true;
const activityKeysIdentical: AssertExact<keyof SdkOutput<typeof listOrgMemberActivity>['activity'][number], keyof OrgMemberActivity> = true;
const trashedKeysIdentical: AssertExact<keyof SdkOutput<typeof listOrgTrashedDrives>['drives'][number], keyof OrgTrashedDrive> = true;
const joinListKeysIdentical: AssertExact<keyof SdkOutput<typeof listDriveJoinRequests>['requests'][number], keyof PendingJoinRequest> = true;
// Drive-org vocabularies.
const implicitIdentical: AssertExact<SdkInput<typeof moveDriveOutOfOrg>['implicitMembers'], ImplicitMembersChoice> = true;
const joinStatusIdentical: AssertExact<SdkOutput<typeof requestToJoinDrive>['request']['status'], Extract<RequestToJoinResult, { ok: true }>['request']['status']> = true;
const joinDecisionIdentical: AssertExact<SdkInput<typeof answerDriveJoinRequest>['decision'], Extract<JoinRequestAnswerResult, { ok: true }>['action']> = true;
const listedVisibilityIdentical: AssertExact<NonNullable<SdkOutput<typeof listDrives>[number]['orgVisibility']>, OrgDriveDirectoryEntry['orgVisibility']> = true;
const createVisibilityIdentical: AssertExact<NonNullable<SdkInput<typeof createDrive>['orgVisibility']>, OrgDriveDirectoryEntry['orgVisibility']> = true;

describe('organization writes, admin reads and drive-org operations — drift guard vs lib', () => {
  it('X-1 (partial) every inlined vocabulary and read-model key set matches lib (compile-time above)', () => {
    expect([
      grantableIdentical,
      patchKeysIdentical,
      suspensionKindIdentical,
      resourceTypeIdentical,
      auditCategoryIdentical,
      automationKindIdentical,
      guestSourceIdentical,
      holdOriginIdentical,
      verifiedMethodIdentical,
      usageKeysIdentical,
      activityKeysIdentical,
      trashedKeysIdentical,
      joinListKeysIdentical,
      implicitIdentical,
      joinStatusIdentical,
      joinDecisionIdentical,
      listedVisibilityIdentical,
      createVisibilityIdentical,
    ].every(Boolean)).toBe(true);
  });
});

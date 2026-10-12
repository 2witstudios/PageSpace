/**
 * Seed operation: `drives.list` (Phase 2 task 5 proof-of-pattern).
 *
 * Route-verified against `apps/web/src/app/api/drives/route.ts` GET
 * (docs/sdk/operations-inventory.md §2.1, parity with MCP tool `list_drives`).
 * Response is a bare array of `DriveWithAccess`
 * (`packages/lib/src/services/drive-service.ts:20`); dates serialize as ISO
 * strings over JSON.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';
import { orgDriveVisibilitySchema } from './organizations.js';

const driveSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  ownerId: z.string(),
  kind: z.enum(['STANDARD', 'HOME']),
  isTrashed: z.boolean(),
  trashedAt: z.string().nullable(),
  drivePrompt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isOwned: z.boolean(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  lastAccessedAt: z.string().nullable(),
  homePageId: z.string().nullable(),
  // X-1: which org owns the drive (null = personal) and its org visibility (DRV-4, meaningful
  // only with an orgId). Tolerant read: a server predating orgs sends neither, and a required key
  // would turn its successful 2xx into a ResponseValidationError.
  orgId: z.string().nullable().optional(),
  orgVisibility: orgDriveVisibilitySchema.optional(),
});

export const listDrives = defineOperation({
  name: 'drives.list',
  method: 'GET',
  path: '/api/drives',
  inputSchema: z.strictObject({
    includeTrash: z.boolean().optional(),
    tokenScopable: z.boolean().optional(),
  }),
  outputSchema: z.array(driveSchema),
  description: 'List drives the caller can access.',
});

export const createDrive = defineOperation({
  name: 'drives.create',
  method: 'POST',
  path: '/api/drives',
  inputSchema: z.strictObject({
    name: z.string().min(1, 'Missing name'),
    /** Create the drive in this organization (DRV-3): org-owned from creation, led by you. */
    orgId: z.string().min(1).optional(),
    /** With `orgId`: Open (the default), Restricted or Private (DRV-4). */
    orgVisibility: orgDriveVisibilitySchema.optional(),
  }),
  outputSchema: driveSchema,
  requiredScope: 'account',
  description:
    "Create a new drive (workspace), personal or — with orgId — owned by that organization from creation, led by you, subject to its \"who can create org drives\" policy and refused while the org is lapsed. Scoped MCP tokens cannot create drives (route-enforced 403) — this always requires an account-level grant. In an org, the org's sign-in policy applies to the key (403 org_strong_sign_in_required / org_reauthentication_required).",
});

/**
 * Raw `drives` table row (`packages/db/src/schema/core.ts`), route-verified
 * against `apps/web/src/app/api/drives/[driveId]/route.ts` PATCH →
 * `updateDrive` (`drives.$inferSelect`). Deliberately distinct from
 * `driveSchema`: this endpoint never synthesizes `isOwned`/`role`/
 * `lastAccessedAt` the way list/create do.
 */
const driveRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  ownerId: z.string(),
  kind: z.enum(['STANDARD', 'HOME']),
  isTrashed: z.boolean(),
  trashedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  drivePrompt: z.string().nullable(),
  publishSubdomain: z.string().nullable(),
  homePageId: z.string().nullable(),
  publishDefaultOgImageUrl: z.string().nullable(),
  // Tolerant read: added post-1.0.0-contract (custom-404/favicon feature)
  // without an API_CONTRACT_VERSION bump, so a server predating them still
  // passes the version handshake. Required keys here would turn that
  // server's successful 2xx into a ResponseValidationError.
  notFoundPageId: z.string().nullable().optional(),
  publishFaviconUrl: z.string().nullable().optional(),
});

export const renameDrive = defineOperation({
  name: 'drives.rename',
  method: 'PATCH',
  path: '/api/drives/:driveId',
  inputSchema: z.strictObject({ driveId: z.string(), name: z.string() }),
  outputSchema: driveRowSchema,
  requiredScope: 'drive:admin',
  description: "Rename a drive. Requires owner/admin authority; a drive's Home drive cannot be renamed.",
});

export const updateDriveContext = defineOperation({
  name: 'drives.updateContext',
  method: 'PATCH',
  path: '/api/drives/:driveId',
  inputSchema: z.strictObject({ driveId: z.string(), drivePrompt: z.string().max(10000) }),
  outputSchema: driveRowSchema,
  requiredScope: 'drive:admin',
  description:
    "Update a drive's AI context prompt. This prompt is loaded into every AI call within the drive, so it directly inflates the token cost of every request there — keep it concise. Requires owner/admin authority.",
});

export const setHomePage = defineOperation({
  name: 'drives.setHomePage',
  method: 'PATCH',
  path: '/api/drives/:driveId',
  inputSchema: z.strictObject({
    driveId: z.string(),
    // min(1): "" must never reach the route (matches the route's own
    // patchSchema — see apps/web/src/app/api/drives/[driveId]/route.ts);
    // null clears the drive's landing page back to the default.
    homePageId: z.string().min(1).nullable(),
  }),
  outputSchema: driveRowSchema,
  requiredScope: 'drive:admin',
  description:
    "Set the page shown as a drive's landing page. Pass null to clear it back to the default. The page must be a non-trashed page belonging to the drive. Requires owner/admin authority.",
});

export const trashDrive = defineOperation({
  name: 'drives.trash',
  method: 'DELETE',
  path: '/api/drives/:driveId',
  inputSchema: z.strictObject({ driveId: z.string(), confirmDriveName: z.string() }),
  outputSchema: z.object({ success: z.literal(true) }),
  requiredScope: 'drive:admin',
  description:
    'Move a drive and all its pages to trash. DELETE is never auto-retried (non-idempotent, per isIdempotentMethod). `confirmDriveName` is a client-side-only guardrail (inventory D11) — the route has no such field and will trash on a bare DELETE — so callers MUST call `assertDriveNameConfirmed(drive.name, confirmDriveName)` before invoking this operation. Requires owner/admin authority; Home drives cannot be trashed.',
});

export const restoreDrive = defineOperation({
  name: 'drives.restore',
  method: 'POST',
  path: '/api/drives/:driveId/restore',
  inputSchema: z.strictObject({ driveId: z.string() }),
  outputSchema: z.object({ success: z.literal(true) }),
  requiredScope: 'drive',
  description:
    'Restore a trashed drive and its pages back to active. OWNER only — an explicit ADMIN-scoped grant is insufficient; only an inherit-scoped principal (acting with its owner\'s authority) can succeed here, so the minimum pre-flightable scope is plain drive access.',
});

// ---------------------------------------------------------------------------
// Org ownership of a drive (Spec DRV-1..DRV-4, DRV-6, X-1)
// ---------------------------------------------------------------------------

/**
 * The org-drive operations are org authority, so they share the org operations' key rules
 * (`operations/organizations.ts`): an unscoped key, and the org's sign-in policy applied to it.
 * Route-verified against `apps/web/src/app/api/drives/[driveId]/org/route.ts` (PUT/DELETE/PATCH),
 * `.../org/lead/route.ts` PUT and `.../join-requests/**`; the services behind them authorize
 * through the web's one org authorization function (ORG-5).
 */
const ORG_DRIVE_KEY_RULES =
  "Requires a key with no drive restriction (a drive-scoped key is refused: 403 token_scope_refused). The organization's sign-in policy applies to the key (403 org_strong_sign_in_required or org_reauthentication_required).";

/** The drive row a move, visibility or lead change answers with: `drives.$inferSelect`, open-world. */
const orgDriveRowSchema = driveRowSchema.extend({
  orgId: z.string().nullable(),
  orgVisibility: orgDriveVisibilitySchema,
});

/** `StorageReattributionResult` (`packages/lib/src/services/storage-limits.ts`): the move's quota re-attribution. */
const storageReattributionSchema = z.object({
  status: z.literal('applied'),
  direction: z.string(),
  movedBytes: z.number(),
  deltas: z.array(z.unknown()),
});

const moveOutputSchema = z.object({ drive: orgDriveRowSchema, storageReattribution: storageReattributionSchema });

/** What happens to org-sourced drive members when a drive leaves its org (D-OW-10). */
export const IMPLICIT_MEMBERS_CHOICES = ['keep', 'remove'] as const;

export const moveDriveToOrg = defineOperation({
  name: 'drives.moveToOrg',
  method: 'PUT',
  path: '/api/drives/:driveId/org',
  inputSchema: z.strictObject({
    driveId: z.string().min(1),
    orgId: z.string().min(1),
    orgVisibility: orgDriveVisibilitySchema.optional(),
  }),
  outputSchema: moveOutputSchema,
  requiredScope: 'account',
  description: `Move a personal drive you own into an organization you belong to (DRV-2): it becomes org-owned, you stay its lead, and its stored files count against the org. Home drives never move; a lapsed org refuses. ${ORG_DRIVE_KEY_RULES}`,
});

export const moveDriveOutOfOrg = defineOperation({
  name: 'drives.moveOutOfOrg',
  method: 'DELETE',
  path: '/api/drives/:driveId/org',
  inputSchema: z.strictObject({
    driveId: z.string().min(1),
    /** `keep`: org members keep access as invited members; `remove`: they lose it. No default. */
    implicitMembers: z.enum(IMPLICIT_MEMBERS_CHOICES),
  }),
  outputSchema: moveOutputSchema,
  requiredScope: 'account',
  destructive: true,
  description: `Move a drive out of its organization back to its lead's personal ownership (DRV-2). Org Owner or Admin only. implicitMembers chooses whether org members keep access as invited members ("keep") or lose it ("remove"). ${ORG_DRIVE_KEY_RULES}`,
});

export const setDriveOrgVisibility = defineOperation({
  name: 'drives.setOrgVisibility',
  method: 'PATCH',
  path: '/api/drives/:driveId/org',
  inputSchema: z.strictObject({ driveId: z.string().min(1), orgVisibility: orgDriveVisibilitySchema }),
  outputSchema: z.object({ drive: orgDriveRowSchema }),
  requiredScope: 'account',
  description: `Change an org drive's visibility (DRV-4): Open (every org member joins), Restricted (listed; members request to join) or Private (invite only). The drive lead or an org Owner/Admin. A lapsed org may only restrict. ${ORG_DRIVE_KEY_RULES}`,
});

export const setDriveOrgLead = defineOperation({
  name: 'drives.setOrgLead',
  method: 'PUT',
  path: '/api/drives/:driveId/org/lead',
  inputSchema: z.strictObject({ driveId: z.string().min(1), userId: z.string().min(1) }),
  outputSchema: z.object({ drive: orgDriveRowSchema }),
  requiredScope: 'account',
  description: `Hand an org drive to a new lead, who must be an org member (DRV-1). The current lead or an org Owner/Admin. ${ORG_DRIVE_KEY_RULES}`,
});

/** `DriveJoinRequestStatus` (`packages/db/src/schema/drive-join-requests.ts`). */
const joinRequestStatusSchema = z.enum(['pending', 'approved', 'denied', 'withdrawn']);

/** A `drive_join_requests` row (`DriveJoinRequest`). */
const joinRequestSchema = z.object({
  id: z.string(),
  driveId: z.string(),
  userId: z.string(),
  status: joinRequestStatusSchema,
  message: z.string().nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
});

/** The answers a join request takes. */
export const JOIN_REQUEST_DECISIONS = ['approve', 'deny'] as const;

export const listDriveJoinRequests = defineOperation({
  name: 'drives.listJoinRequests',
  method: 'GET',
  path: '/api/drives/:driveId/join-requests',
  inputSchema: z.strictObject({ driveId: z.string().min(1) }),
  outputSchema: z.object({
    requests: z.array(
      z.object({
        id: z.string(),
        userId: z.string(),
        name: z.string().nullable(),
        email: z.string(),
        image: z.string().nullable(),
        message: z.string().nullable(),
        requestedAt: z.string(),
      }),
    ),
  }),
  requiredScope: 'account',
  description: `List the pending requests to join a Restricted org drive (DRV-6). The drive lead or an org Owner/Admin. ${ORG_DRIVE_KEY_RULES}`,
});

export const requestToJoinDrive = defineOperation({
  name: 'drives.requestToJoin',
  method: 'POST',
  path: '/api/drives/:driveId/join-requests',
  inputSchema: z.strictObject({ driveId: z.string().min(1), message: z.string().max(500).optional() }),
  outputSchema: z.object({ request: joinRequestSchema }),
  requiredScope: 'account',
  description: `Ask to join a Restricted drive of an organization you belong to (find them with organizations.listDrives). Idempotent while a request is open; it grants nothing until the lead or an org Owner/Admin approves. ${ORG_DRIVE_KEY_RULES}`,
});

export const answerDriveJoinRequest = defineOperation({
  name: 'drives.answerJoinRequest',
  method: 'PATCH',
  path: '/api/drives/:driveId/join-requests/:requestId',
  inputSchema: z.strictObject({
    driveId: z.string().min(1),
    requestId: z.string().min(1),
    decision: z.enum(JOIN_REQUEST_DECISIONS),
  }),
  outputSchema: z.object({ request: joinRequestSchema, admitted: z.boolean() }),
  requiredScope: 'account',
  description: `Approve or deny a request to join a Restricted org drive; approval is the only path from a request to membership. The drive lead or an org Owner/Admin, never on their own request. ${ORG_DRIVE_KEY_RULES}`,
});

export const withdrawDriveJoinRequest = defineOperation({
  name: 'drives.withdrawJoinRequest',
  method: 'DELETE',
  path: '/api/drives/:driveId/join-requests/:requestId',
  inputSchema: z.strictObject({ driveId: z.string().min(1), requestId: z.string().min(1) }),
  outputSchema: z.object({ request: joinRequestSchema }),
  requiredScope: 'account',
  description: `Withdraw your own pending request to join a drive; you may ask again later. Requester only. ${ORG_DRIVE_KEY_RULES}`,
});

export interface ConfirmMismatch {
  readonly actualName: string;
  readonly confirmName: string;
}

export type Result<TValue, TError> = { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly error: TError };

/**
 * D11: `trash_drive`'s `confirmDriveName` guardrail is client-side only —
 * the route (`apps/web/src/app/api/drives/[driveId]/route.ts` DELETE) has no
 * such field and trashes unconditionally. Every caller of `trashDrive`
 * (CLI, MCP adapter) MUST run this first and fail closed on a mismatch.
 * Pure, total, case- and whitespace-sensitive (no fuzzy matching).
 */
export function assertDriveNameConfirmed(actualName: string, confirmName: string): Result<void, ConfirmMismatch> {
  if (actualName === confirmName) {
    return { ok: true, value: undefined };
  }
  return { ok: false, error: { actualName, confirmName } };
}

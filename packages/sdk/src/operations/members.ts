/**
 * Members operation: `members.list` (Phase 3 task 1, drives & members domain).
 *
 * Route-verified against `apps/web/src/app/api/drives/[driveId]/members/route.ts`
 * GET → `listDriveMembers` + `getDriveOwnerAsMember`
 * (`packages/lib/src/services/drive-member-service.ts`), parity with MCP tool
 * `list_drive_members` (docs/sdk/operations-inventory.md §2.15). The owner is
 * never a `drive_members` row, so the route prepends a synthesized owner entry;
 * `pendingInvites` is always an array (empty for non-owner/admin callers, never
 * omitted) to keep the response shape stable across viewer roles.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const memberRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);

const driveMemberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  role: memberRoleSchema,
  /** How their standing came to be (DRV-5, DRV-8): an invitation, org membership, or the lead. Optional: older servers omit it. */
  source: z.enum(['invite', 'org', 'lead']).optional(),
  /** DRV-8: a member of an org drive with no role in its org (labeled a guest). Optional: older servers omit it. */
  isGuest: z.boolean().optional(),
  invitedBy: z.string().nullable(),
  invitedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  lastAccessedAt: z.string().nullable(),
  user: z
    .object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
    })
    .nullable(),
  profile: z
    .object({
      username: z.string().nullable(),
      displayName: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    })
    .nullable(),
  customRole: z
    .object({
      id: z.string(),
      name: z.string(),
      color: z.string().nullable(),
    })
    .nullable(),
  permissionCounts: z
    .object({
      view: z.number(),
      edit: z.number(),
      share: z.number(),
    })
    .optional(),
});

/** A page-link guest (D-OW-24): not a member; listed apart for the lead and admins. */
const pageLinkGuestSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  source: z.enum(['invite', 'org']),
  pageGrantCount: z.number(),
});

const pendingInviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: memberRoleSchema,
  customRoleId: z.string().nullable(),
  customRoleName: z.string().nullable(),
  customRoleColor: z.string().nullable(),
  driveId: z.string(),
  invitedByName: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});

export const listDriveMembers = defineOperation({
  name: 'members.list',
  method: 'GET',
  path: '/api/drives/:driveId/members',
  inputSchema: z.strictObject({ driveId: z.string() }),
  outputSchema: z.object({
    members: z.array(driveMemberSchema),
    pendingInvites: z.array(pendingInviteSchema),
    /** Page-link guests; empty for non-owner/admin callers. Optional: older servers omit it. */
    guests: z.array(pageLinkGuestSchema).optional(),
    currentUserRole: memberRoleSchema,
  }),
  requiredScope: 'drive',
  description:
    'List all members of a drive (including the owner) with roles and permission counts. Pending invites are visible to OWNER/ADMIN callers only, but the field is always an array.',
});

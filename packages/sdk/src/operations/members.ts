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
    currentUserRole: memberRoleSchema,
  }),
  requiredScope: 'drive',
  description:
    'List all members of a drive (including the owner) with roles and permission counts. Pending invites are visible to OWNER/ADMIN callers only, but the field is always an array.',
});

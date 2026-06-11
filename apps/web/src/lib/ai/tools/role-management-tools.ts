import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import {
  checkDriveAccessForRoles,
  listDriveRoles,
  getRoleById,
  createDriveRole,
  updateDriveRole,
  deleteDriveRole,
  type DriveRoleAccessInfo,
  type RolePermissions,
} from '@pagespace/lib/services/drive-role-service';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import type { ToolExecutionContext } from '../core/types';
import { driveDeniedByAppToken } from './actor-permissions';
import { getAiContextWithActor } from './task-helpers';

const driveIdSchema = z.string().regex(/^[a-z][a-z0-9]{1,31}$/, 'Invalid drive ID format');

const driveWidePermissionsSchema = z.object({
  canView: z.boolean(),
  canEdit: z.boolean(),
  canShare: z.boolean(),
});

type AdminGate =
  | { ok: true; access: DriveRoleAccessInfo & { drive: NonNullable<DriveRoleAccessInfo['drive']> } }
  | { ok: false; error: { success: false; error: string } };

async function requireDriveAdmin(
  context: ToolExecutionContext,
  driveId: string
): Promise<AdminGate> {
  if (await driveDeniedByAppToken(context, driveId, 'manage')) {
    return { ok: false, error: { success: false, error: 'This token does not have access to this drive' } };
  }

  const access = await checkDriveAccessForRoles(driveId, context.userId);
  if (!access.drive) return { ok: false, error: { success: false, error: 'Drive not found' } };
  if (!access.isOwner && !access.isAdmin) {
    return { ok: false, error: { success: false, error: 'You must be a drive admin or owner to manage roles' } };
  }

  return { ok: true, access: { ...access, drive: access.drive } };
}

const mergePagePermission = (
  permissions: RolePermissions,
  pageId: string,
  perm: { canView: boolean; canEdit: boolean; canShare: boolean }
): RolePermissions => ({ ...permissions, [pageId]: perm });

const prunePagePermission = (permissions: RolePermissions, pageId: string): RolePermissions =>
  Object.fromEntries(Object.entries(permissions).filter(([key]) => key !== pageId));

async function logAndBroadcastRoleChange(
  context: ToolExecutionContext,
  driveId: string,
  driveName: string,
  action: 'create' | 'update' | 'delete',
  roleName: string
): Promise<void> {
  // Broadcast is best-effort: the mutation has already committed, so a socket
  // failure must not surface as a tool error (mirrors the role API routes).
  try {
    const recipientUserIds = await getDriveRecipientUserIds(driveId);
    await broadcastDriveEvent(createDriveEventPayload(driveId, 'updated', {}), recipientUserIds);
  } catch (broadcastError) {
    console.error('Failed to broadcast role change event for drive', driveId, broadcastError);
  }
  logDriveActivity(context.userId, action, { id: driveId, name: `${driveName} — role "${roleName}"` },
    await getAiContextWithActor(context));
}

export const roleManagementTools = {
  list_drive_roles: tool({
    description: 'List all custom roles in a drive with their names, colors, and positions. Use this to discover existing roles before creating new ones or assigning roles to members.',
    inputSchema: z.object({
      driveId: driveIdSchema.describe('The ID of the drive to list roles for'),
    }),
    execute: async ({ driveId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      if (await driveDeniedByAppToken(context as ToolExecutionContext, driveId, 'view')) {
        return { success: false, error: 'This token does not have access to this drive' };
      }

      const access = await checkDriveAccessForRoles(driveId, userId);
      if (!access.drive) return { success: false, error: 'Drive not found' };
      if (!access.isOwner && !access.isMember) {
        return { success: false, error: 'You must be a drive member to view roles' };
      }

      const roles = await listDriveRoles(driveId);

      return {
        success: true,
        roles: roles.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          color: r.color,
          isDefault: r.isDefault,
          driveWidePermissions: r.driveWidePermissions,
          position: r.position,
        })),
        summary: `${roles.length} role${roles.length === 1 ? '' : 's'} in "${access.drive.name}"`,
        stats: { total: roles.length, driveName: access.drive.name },
        nextSteps: [
          'Use get_drive_role to inspect a role\'s full permissions',
          'Use create_drive_role to add a new role',
        ],
      };
    },
  }),

  get_drive_role: tool({
    description: 'Get a single drive role with its full per-page permissions map and drive-wide permissions. Use after list_drive_roles to inspect what a role can access.',
    inputSchema: z.object({
      driveId: driveIdSchema.describe('The ID of the drive the role belongs to'),
      roleId: z.string().describe('The ID of the role to fetch'),
    }),
    execute: async ({ driveId, roleId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      if (await driveDeniedByAppToken(context as ToolExecutionContext, driveId, 'view')) {
        return { success: false, error: 'This token does not have access to this drive' };
      }

      const access = await checkDriveAccessForRoles(driveId, userId);
      if (!access.drive) return { success: false, error: 'Drive not found' };
      if (!access.isOwner && !access.isMember) {
        return { success: false, error: 'You must be a drive member to view roles' };
      }

      const role = await getRoleById(driveId, roleId);
      if (!role) return { success: false, error: `Role "${roleId}" not found in this drive` };

      return {
        success: true,
        role: {
          id: role.id,
          name: role.name,
          description: role.description,
          color: role.color,
          isDefault: role.isDefault,
          permissions: role.permissions,
          driveWidePermissions: role.driveWidePermissions,
          position: role.position,
        },
        summary: `Role "${role.name}" in "${access.drive.name}"`,
        stats: { driveName: access.drive.name, pagePermissionCount: Object.keys(role.permissions).length },
        nextSteps: [
          'Use set_role_page_permissions to grant this role access to a page',
          'Use set_role_drive_wide_permissions to apply drive-wide access',
        ],
      };
    },
  }),

  create_drive_role: tool({
    description: 'Create a new custom role in a drive. Optionally set drive-wide permissions (canView/canEdit/canShare applying to all non-private pages, including future ones; private pages always need per-page grants). Requires drive admin or owner.',
    inputSchema: z.object({
      driveId: driveIdSchema.describe('The ID of the drive to create the role in'),
      name: z.string().min(1).describe('Role name, unique within the drive'),
      description: z.string().optional().describe('What this role is for'),
      color: z.string().optional().describe('Display color (hex)'),
      driveWidePermissions: driveWidePermissionsSchema.nullable().optional()
        .describe('Permissions applying to all non-private pages in the drive, including future ones. Private pages always require per-page grants (set_role_page_permissions). Omit or null for per-page-only.'),
    }),
    execute: async ({ driveId, name, description, color, driveWidePermissions }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      const gate = await requireDriveAdmin(context as ToolExecutionContext, driveId);
      if (!gate.ok) return gate.error;

      try {
        const role = await createDriveRole(driveId, {
          name,
          description: description ?? null,
          color: color ?? null,
          permissions: {},
          driveWidePermissions: driveWidePermissions ?? null,
        });

        await logAndBroadcastRoleChange(context as ToolExecutionContext, driveId, gate.access.drive.name, 'create', role.name);

        return {
          success: true,
          role: {
            id: role.id,
            name: role.name,
            description: role.description,
            color: role.color,
            driveWidePermissions: role.driveWidePermissions,
            position: role.position,
          },
          summary: `Created role "${role.name}" in "${gate.access.drive.name}"`,
          stats: { driveName: gate.access.drive.name },
          nextSteps: [
            'Use set_role_page_permissions to grant page access',
            'Use set_role_drive_wide_permissions to apply drive-wide access',
          ],
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to create role' };
      }
    },
  }),

  update_drive_role: tool({
    description: 'Update a custom role\'s name, description, color, or drive-wide permissions. Requires drive admin or owner.',
    inputSchema: z.object({
      driveId: driveIdSchema.describe('The ID of the drive the role belongs to'),
      roleId: z.string().describe('The ID of the role to update'),
      name: z.string().min(1).optional().describe('New role name'),
      description: z.string().nullable().optional().describe('New description'),
      color: z.string().nullable().optional().describe('New display color'),
      driveWidePermissions: driveWidePermissionsSchema.nullable().optional()
        .describe('New drive-wide permissions; null clears them'),
    }),
    execute: async ({ driveId, roleId, name, description, color, driveWidePermissions }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      const gate = await requireDriveAdmin(context as ToolExecutionContext, driveId);
      if (!gate.ok) return gate.error;

      try {
        const { role } = await updateDriveRole(driveId, roleId, {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(color !== undefined && { color }),
          ...(driveWidePermissions !== undefined && { driveWidePermissions }),
        });

        await logAndBroadcastRoleChange(context as ToolExecutionContext, driveId, gate.access.drive.name, 'update', role.name);

        return {
          success: true,
          role: {
            id: role.id,
            name: role.name,
            description: role.description,
            color: role.color,
            driveWidePermissions: role.driveWidePermissions,
            position: role.position,
          },
          summary: `Updated role "${role.name}" in "${gate.access.drive.name}"`,
          stats: { driveName: gate.access.drive.name },
          nextSteps: ['Use get_drive_role to verify the changes'],
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to update role' };
      }
    },
  }),

  delete_drive_role: tool({
    description: 'Delete a custom role from a drive. Members holding this role revert to plain members. Requires drive admin or owner.',
    inputSchema: z.object({
      driveId: driveIdSchema.describe('The ID of the drive the role belongs to'),
      roleId: z.string().describe('The ID of the role to delete'),
    }),
    execute: async ({ driveId, roleId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      const gate = await requireDriveAdmin(context as ToolExecutionContext, driveId);
      if (!gate.ok) return gate.error;

      try {
        const role = await getRoleById(driveId, roleId);
        const roleName = role?.name ?? roleId;
        await deleteDriveRole(driveId, roleId);

        await logAndBroadcastRoleChange(context as ToolExecutionContext, driveId, gate.access.drive.name, 'delete', roleName);

        return {
          success: true,
          summary: `Deleted role "${roleName}" from "${gate.access.drive.name}" — members with this role revert to plain members`,
          stats: { driveName: gate.access.drive.name },
          nextSteps: ['Use list_drive_roles to see remaining roles'],
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to delete role' };
      }
    },
  }),

  set_role_page_permissions: tool({
    description: 'Grant or change a role\'s permissions (view/edit/share) on a specific page. Merges into the role\'s per-page permission map. Requires drive admin or owner.',
    inputSchema: z.object({
      driveId: driveIdSchema.describe('The ID of the drive the role belongs to'),
      roleId: z.string().describe('The ID of the role to modify'),
      pageId: z.string().describe('The ID of the page to set permissions for (must be in the same drive)'),
      canView: z.boolean().describe('Whether the role can view the page'),
      canEdit: z.boolean().describe('Whether the role can edit the page'),
      canShare: z.boolean().describe('Whether the role can share the page'),
    }),
    execute: async ({ driveId, roleId, pageId, canView, canEdit, canShare }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      const gate = await requireDriveAdmin(context as ToolExecutionContext, driveId);
      if (!gate.ok) return gate.error;

      try {
        const role = await getRoleById(driveId, roleId);
        if (!role) return { success: false, error: `Role "${roleId}" not found in this drive` };

        const page = await db.query.pages.findFirst({
          where: and(eq(pages.id, pageId), eq(pages.driveId, driveId)),
        });
        if (!page) return { success: false, error: `Page "${pageId}" not found in this drive` };

        const merged = mergePagePermission(role.permissions, pageId, { canView, canEdit, canShare });
        await updateDriveRole(driveId, roleId, { permissions: merged });

        await logAndBroadcastRoleChange(context as ToolExecutionContext, driveId, gate.access.drive.name, 'update', role.name);

        return {
          success: true,
          summary: `Set ${role.name}'s permissions on page ${pageId}: view=${canView}, edit=${canEdit}, share=${canShare}`,
          stats: { driveName: gate.access.drive.name, pagePermissionCount: Object.keys(merged).length },
          nextSteps: ['Use get_drive_role to see the full permission map'],
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to set page permissions' };
      }
    },
  }),

  set_role_drive_wide_permissions: tool({
    description: 'Set a role\'s drive-wide permissions (view/edit/share applying to all non-private pages in the drive, including future ones). Private pages are excluded — they always require per-page grants via set_role_page_permissions. Per-page permissions still override. Requires drive admin or owner.',
    inputSchema: z.object({
      driveId: driveIdSchema.describe('The ID of the drive the role belongs to'),
      roleId: z.string().describe('The ID of the role to modify'),
      canView: z.boolean().describe('Whether the role can view all non-private pages'),
      canEdit: z.boolean().describe('Whether the role can edit all non-private pages'),
      canShare: z.boolean().describe('Whether the role can share all non-private pages'),
    }),
    execute: async ({ driveId, roleId, canView, canEdit, canShare }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      const gate = await requireDriveAdmin(context as ToolExecutionContext, driveId);
      if (!gate.ok) return gate.error;

      try {
        const { role } = await updateDriveRole(driveId, roleId, {
          driveWidePermissions: { canView, canEdit, canShare },
        });

        await logAndBroadcastRoleChange(context as ToolExecutionContext, driveId, gate.access.drive.name, 'update', role.name);

        return {
          success: true,
          summary: `Set ${role.name}'s drive-wide permissions: view=${canView}, edit=${canEdit}, share=${canShare}`,
          stats: { driveName: gate.access.drive.name },
          nextSteps: [
            'Use get_drive_role to verify',
            'Per-page grants override drive-wide settings',
            'Private pages are not covered — use set_role_page_permissions for those',
          ],
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to set drive-wide permissions' };
      }
    },
  }),

  remove_role_page_permissions: tool({
    description: 'Remove a role\'s per-page permission entry for a specific page, so the role falls back to its drive-wide permissions (if any). Idempotent. Requires drive admin or owner.',
    inputSchema: z.object({
      driveId: driveIdSchema.describe('The ID of the drive the role belongs to'),
      roleId: z.string().describe('The ID of the role to modify'),
      pageId: z.string().describe('The ID of the page whose permission entry should be removed'),
    }),
    execute: async ({ driveId, roleId, pageId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      const gate = await requireDriveAdmin(context as ToolExecutionContext, driveId);
      if (!gate.ok) return gate.error;

      try {
        const role = await getRoleById(driveId, roleId);
        if (!role) return { success: false, error: `Role "${roleId}" not found in this drive` };

        if (!(pageId in role.permissions)) {
          return {
            success: true,
            summary: `Role "${role.name}" had no permission entry for page ${pageId} — nothing to remove`,
            stats: { driveName: gate.access.drive.name, pagePermissionCount: Object.keys(role.permissions).length },
            nextSteps: ['Use get_drive_role to see the current permission map'],
          };
        }

        const pruned = prunePagePermission(role.permissions, pageId);
        await updateDriveRole(driveId, roleId, { permissions: pruned });

        await logAndBroadcastRoleChange(context as ToolExecutionContext, driveId, gate.access.drive.name, 'update', role.name);

        return {
          success: true,
          summary: `Removed ${role.name}'s permission entry for page ${pageId}`,
          stats: { driveName: gate.access.drive.name, pagePermissionCount: Object.keys(pruned).length },
          nextSteps: ['Use get_drive_role to see the remaining permission map'],
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to remove page permissions' };
      }
    },
  }),
};

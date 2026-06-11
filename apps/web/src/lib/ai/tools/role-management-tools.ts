import { tool } from 'ai';
import { z } from 'zod';
import {
  checkDriveAccessForRoles,
  listDriveRoles,
  getRoleById,
} from '@pagespace/lib/services/drive-role-service';
import type { ToolExecutionContext } from '../core/types';
import { driveDeniedByAppToken } from './actor-permissions';

const driveIdSchema = z.string().regex(/^[a-z][a-z0-9]{1,31}$/, 'Invalid drive ID format');

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
};

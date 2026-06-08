import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { userProfiles } from '@pagespace/db/schema/members';
import { connections } from '@pagespace/db/schema/social';
import { checkDriveAccess, listDriveMembers } from '@pagespace/lib/services/drive-member-service';
import type { ToolExecutionContext } from '../core/types';
import { driveOutsideMcpScope } from './actor-permissions';

export const memberTools = {
  list_drive_members: tool({
    description: 'List all members of a drive/workspace with their user IDs, names, emails, and roles. Use this before assigning tasks, inviting people by ID, or sending channel messages — it gives you the userId needed for those operations.',
    inputSchema: z.object({
      driveId: z.string().regex(/^[a-z][a-z0-9]{1,31}$/, 'Invalid drive ID format').describe('The ID of the drive to list members for'),
    }),
    execute: async ({ driveId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      if (driveOutsideMcpScope(context as ToolExecutionContext, driveId)) {
        return { success: false, error: 'This token does not have access to this drive' };
      }

      const access = await checkDriveAccess(driveId, userId);
      if (!access.drive) return { success: false, error: 'Drive not found' };
      if (!access.isOwner && !access.isMember) {
        return { success: false, error: 'You must be a drive member to view members' };
      }

      // Fetch owner — stored in drives.ownerId, not in drive_members table
      const [ownerRow] = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          displayName: userProfiles.displayName,
          avatarUrl: userProfiles.avatarUrl,
        })
        .from(drives)
        .leftJoin(users, eq(drives.ownerId, users.id))
        .leftJoin(userProfiles, eq(drives.ownerId, userProfiles.userId))
        .where(eq(drives.id, driveId))
        .limit(1);

      // Fetch accepted members
      const memberRows = await listDriveMembers(driveId);

      const result = [];

      if (ownerRow?.id) {
        result.push({
          userId: ownerRow.id,
          name: ownerRow.name,
          displayName: ownerRow.displayName ?? ownerRow.name,
          email: ownerRow.email,
          role: 'OWNER' as const,
          avatarUrl: ownerRow.avatarUrl ?? null,
        });
      }

      for (const m of memberRows) {
        if (!m.user?.id || !m.acceptedAt) continue;
        // Skip if already added as owner (owner can have an accepted drive_members row too)
        if (ownerRow?.id && m.user.id === ownerRow.id) continue;
        result.push({
          userId: m.user.id,
          name: m.user.name,
          displayName: m.profile?.displayName ?? m.user.name,
          email: m.user.email,
          role: m.role,
          avatarUrl: m.profile?.avatarUrl ?? null,
        });
      }

      return {
        success: true,
        members: result,
        summary: `${result.length} member${result.length === 1 ? '' : 's'} in "${access.drive.name}"`,
        stats: { total: result.length, driveName: access.drive.name },
        nextSteps: ["Use a member's userId to assign tasks, send channel messages, or invite them to pages"],
      };
    },
  }),

  list_collaborators: tool({
    description: "List all users you're connected to (accepted connections). Returns their user IDs, names, and emails — useful for finding people across drives to assign, invite, or message.",
    inputSchema: z.object({}),
    execute: async ({}, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      // connections is bidirectional — user can be user1Id or user2Id
      const asUser1 = await db
        .select({ otherId: connections.user2Id, connectedSince: connections.acceptedAt })
        .from(connections)
        .where(and(eq(connections.user1Id, userId), eq(connections.status, 'ACCEPTED')));

      const asUser2 = await db
        .select({ otherId: connections.user1Id, connectedSince: connections.acceptedAt })
        .from(connections)
        .where(and(eq(connections.user2Id, userId), eq(connections.status, 'ACCEPTED')));

      const all = [...asUser1, ...asUser2];

      if (all.length === 0) {
        return {
          success: true,
          collaborators: [],
          summary: 'No accepted connections yet',
          stats: { total: 0 },
          nextSteps: ['Connections are accepted friend/collaborator requests on PageSpace'],
        };
      }

      const otherIds = all.map((c) => c.otherId);
      const connectedSinceMap = new Map(all.map((c) => [c.otherId, c.connectedSince]));

      const userRows = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          displayName: userProfiles.displayName,
          avatarUrl: userProfiles.avatarUrl,
        })
        .from(users)
        .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
        .where(inArray(users.id, otherIds));

      const collaborators = userRows.map((u) => ({
        userId: u.id,
        name: u.name,
        displayName: u.displayName ?? u.name,
        email: u.email,
        avatarUrl: u.avatarUrl ?? null,
        connectedSince: connectedSinceMap.get(u.id) ?? null,
      }));

      return {
        success: true,
        collaborators,
        summary: `${collaborators.length} collaborator${collaborators.length === 1 ? '' : 's'}`,
        stats: { total: collaborators.length },
        nextSteps: ["Use a collaborator's userId to assign tasks, invite them to a drive, or send them a message"],
      };
    },
  }),
};

import { tool } from 'ai';
import { z } from 'zod';
import { db, pages, drives, eq, and, driveMembers, pagePermissions, ne } from '@pagespace/db';
import { slugify, logDriveActivity, getActorInfo } from '@pagespace/lib/server';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { type ToolExecutionContext } from '../core';

// Helper: Extract AI attribution context with actor info for activity logging
async function getAiContextWithActor(context: ToolExecutionContext) {
  const actorInfo = await getActorInfo(context.userId);
  // Build chain metadata (Tier 1)
  const chainMetadata = {
    ...(context.parentAgentId && { parentAgentId: context.parentAgentId }),
    ...(context.parentConversationId && { parentConversationId: context.parentConversationId }),
    ...(context.agentChain?.length && { agentChain: context.agentChain }),
    ...(context.requestOrigin && { requestOrigin: context.requestOrigin }),
  };

  return {
    ...actorInfo,
    isAiGenerated: true,
    aiProvider: context.aiProvider,
    aiModel: context.aiModel,
    aiConversationId: context.conversationId,
    metadata: Object.keys(chainMetadata).length > 0 ? chainMetadata : undefined,
  };
}

export const driveTools = {
  /**
   * Discover what workspaces/drives are available to the user
   */
  list_drives: tool({
    description: 'List all available workspaces/drives that the user has access to. Returns drive names, slugs, and basic metadata.',
    inputSchema: z.object({}),
    execute: async ({}, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // 1. Get user's own drives
        const ownedDrives = await db
          .select({
            id: drives.id,
            name: drives.name,
            slug: drives.slug,
            createdAt: drives.createdAt,
            ownerId: drives.ownerId,
          })
          .from(drives)
          .where(eq(drives.ownerId, userId));

        // 2. Get drives where user is a member
        const memberDrives = await db.selectDistinct({ 
          id: drives.id,
          name: drives.name,
          slug: drives.slug,
          createdAt: drives.createdAt,
          ownerId: drives.ownerId,
        })
          .from(driveMembers)
          .leftJoin(drives, eq(driveMembers.driveId, drives.id))
          .where(and(
            eq(driveMembers.userId, userId),
            ne(drives.ownerId, userId) // Exclude owned drives
          ));

        // 3. Get drives where user has page permissions
        const permissionDrives = await db.selectDistinct({
          id: drives.id,
          name: drives.name,
          slug: drives.slug,
          createdAt: drives.createdAt,
          ownerId: drives.ownerId,
        })
          .from(pagePermissions)
          .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
          .leftJoin(drives, eq(pages.driveId, drives.id))
          .where(and(
            eq(pagePermissions.userId, userId),
            eq(pagePermissions.canView, true),
            ne(drives.ownerId, userId) // Exclude owned drives
          ));

        // 4. Combine all drives and deduplicate
        const allDrives = [...ownedDrives, ...memberDrives, ...permissionDrives];
        const uniqueDrives = Array.from(new Map(allDrives.map(d => [d.id, d])).values());

        return {
          success: true,
          drives: uniqueDrives.map(drive => ({
            id: drive.id,
            slug: drive.slug,
            title: drive.name,
            description: '',
            isDefault: false,
          })),
          summary: `Found ${uniqueDrives.length} workspace${uniqueDrives.length === 1 ? '' : 's'} available`,
          stats: {
            totalDrives: uniqueDrives.length,
            driveNames: uniqueDrives.map(d => d.name)
          },
          nextSteps: uniqueDrives.length > 0 ? [
            'Use list_pages with both driveSlug and driveId from above to explore the structure of any workspace',
            'Use read_page to examine specific documents for context'
          ] : ['Create a new workspace if needed']
        };
      } catch (error) {
        console.error('Error reading drives:', error);
        throw new Error('Failed to read drives');
      }
    },
  }),

  /**
   * Create a new workspace/drive
   */
  create_drive: tool({
    description: 'Create a new workspace/drive. Use when user explicitly requests a new workspace or when their project clearly doesn\'t fit existing drives.',
    inputSchema: z.object({
      name: z.string().describe('The name of the new drive/workspace'),
    }),
    execute: async ({ name }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Validate name
        if (!name || name.trim().length === 0) {
          throw new Error('Drive name is required');
        }
        
        if (name.toLowerCase() === 'personal') {
          throw new Error('Cannot create a drive named "Personal"');
        }

        // Generate slug from name
        const slug = name.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-');

        // Create the new drive
        const [newDrive] = await db.insert(drives).values({
          name: name.trim(),
          slug,
          ownerId: userId,
          updatedAt: new Date(),
        }).returning({
          id: drives.id,
          name: drives.name,
          slug: drives.slug,
        });

        // Broadcast drive creation event
        await broadcastDriveEvent(
          createDriveEventPayload(newDrive.id, 'created', {
            name: newDrive.name,
            slug: newDrive.slug,
          })
        );

        // Log activity for AI-generated drive creation
        logDriveActivity(userId, 'create', {
          id: newDrive.id,
          name: newDrive.name,
        }, await getAiContextWithActor(context as ToolExecutionContext));

        return {
          success: true,
          drive: {
            id: newDrive.id,
            name: newDrive.name,
            slug: newDrive.slug,
          },
          message: `Successfully created workspace "${newDrive.name}"`,
          summary: `Created new workspace "${newDrive.name}" with slug "${newDrive.slug}"`,
          stats: {
            driveName: newDrive.name,
            driveSlug: newDrive.slug,
          },
          nextSteps: [
            `Use list_pages with driveSlug: "${newDrive.slug}" and driveId: "${newDrive.id}" to explore the new workspace`,
            'Create folders and documents to organize your content',
            'Consider creating an AI_CHAT page for workspace-specific assistance',
          ]
        };
      } catch (error) {
        console.error('Error creating drive:', error);
        throw new Error(`Failed to create drive: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Rename an existing workspace/drive
   */
  rename_drive: tool({
    description: 'Rename an existing workspace/drive. Only the drive owner can rename their drives.',
    inputSchema: z.object({
      currentName: z.string().describe('Current name of the drive for display context'),
      driveId: z.string().describe('The unique ID of the drive to rename'),
      name: z.string().describe('The new name for the drive'),
    }),
    execute: async ({ currentName, driveId, name }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Validate name
        if (!name || name.trim().length === 0) {
          throw new Error('Drive name is required');
        }
        
        if (name.toLowerCase() === 'personal') {
          throw new Error('Cannot rename a drive to "Personal"');
        }

        // Find the drive and verify ownership
        const drive = await db.query.drives.findFirst({
          where: and(
            eq(drives.id, driveId),
            eq(drives.ownerId, userId)
          ),
        });

        if (!drive) {
          throw new Error('Drive not found or you do not have permission to rename it');
        }

        // Update the drive name and regenerate slug
        const [updatedDrive] = await db
          .update(drives)
          .set({
            name: name.trim(),
            slug: slugify(name.trim()),
            updatedAt: new Date(),
          })
          .where(eq(drives.id, drive.id))
          .returning({
            id: drives.id,
            name: drives.name,
            slug: drives.slug,
          });

        // Broadcast drive update event
        await broadcastDriveEvent(
          createDriveEventPayload(updatedDrive.id, 'updated', {
            name: updatedDrive.name,
            slug: updatedDrive.slug,
          })
        );

        // Log activity for AI-generated drive rename
        logDriveActivity(userId, 'update', {
          id: updatedDrive.id,
          name: updatedDrive.name,
        }, {
          ...await getAiContextWithActor(context as ToolExecutionContext),
          metadata: { oldName: drive.name, newName: updatedDrive.name },
        });

        return {
          success: true,
          drive: {
            id: updatedDrive.id,
            name: updatedDrive.name,
            slug: updatedDrive.slug,
            oldName: drive.name,
          },
          message: `Successfully renamed workspace from "${drive.name}" to "${updatedDrive.name}"`,
          summary: `Renamed workspace to "${updatedDrive.name}"`,
          stats: {
            oldName: drive.name,
            newName: updatedDrive.name,
            driveSlug: updatedDrive.slug,
          },
          nextSteps: [
            `Workspace slug updated to "${updatedDrive.slug}"`,
            'All pages and content remain unchanged',
          ]
        };
      } catch (error) {
        console.error('Error renaming drive:', error);
        throw new Error(`Failed to rename drive "${currentName}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull, ne, or } from '@pagespace/db/operators';
import { commands } from '@pagespace/db/schema/commands';
import type { SelectCommand } from '@pagespace/db/schema/commands';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import {
  isReservedTrigger,
  validateCommandDescription,
  validateCommandTrigger,
} from '@pagespace/lib/commands/command-core';
import { canUserViewPage, isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { maskIdentifier } from '@/lib/logging/mask';
import type { ToolExecutionContext } from '../core/types';

const commandLogger = loggers.ai.child({ module: 'command-tools' });

async function getMemberDriveIds(userId: string): Promise<string[]> {
  const driveIds = new Set<string>();
  const owned = await db
    .select({ id: drives.id })
    .from(drives)
    .where(and(eq(drives.ownerId, userId), eq(drives.isTrashed, false)));
  for (const drive of owned) driveIds.add(drive.id);
  const memberships = await db
    .select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .innerJoin(drives, eq(driveMembers.driveId, drives.id))
    .where(
      and(
        eq(driveMembers.userId, userId),
        isNotNull(driveMembers.acceptedAt),
        eq(drives.isTrashed, false)
      )
    );
  for (const m of memberships) driveIds.add(m.driveId);
  return Array.from(driveIds);
}

async function loadCommandForManage(userId: string, commandId: string): Promise<SelectCommand> {
  const command = await db.query.commands.findFirst({
    where: eq(commands.id, commandId),
  });
  if (!command) throw new Error('Command not found');
  if (command.userId !== null) {
    if (command.userId !== userId) throw new Error('Command not found');
    return command;
  }
  const allowed = await isDriveOwnerOrAdmin(userId, command.driveId as string);
  if (!allowed) throw new Error('Only the drive owner or admins can manage drive commands');
  return command;
}

async function validateEntryPageForTool(
  userId: string,
  entryPageId: string,
  commandDriveId: string | null
): Promise<void> {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, entryPageId),
    columns: { id: true, driveId: true, isTrashed: true },
  });
  if (!page) throw new Error('Entry page not found');
  if (page.isTrashed) throw new Error('Entry page is in the trash');
  const canView = await canUserViewPage(userId, entryPageId);
  if (!canView) throw new Error('You do not have access to the entry page');
  if (commandDriveId !== null && page.driveId !== commandDriveId) {
    throw new Error("A drive command's entry page must be in the same drive");
  }
}

export const commandTools = {
  create_command: tool({
    description:
      "Register a page as a slash command. After creation, users can type /trigger in any AI chat input to inject the page's content into context. Personal commands are visible only to you; drive commands are shared with everyone in the drive.",
    inputSchema: z.object({
      trigger: z
        .string()
        .describe(
          'Slash command name. Must be 1–64 lowercase letters, numbers, and hyphens — no leading, trailing, or consecutive hyphens. Example: "release-checklist".'
        ),
      description: z
        .string()
        .describe('What this command does and when to use it (1–1024 chars).'),
      entryPageId: z
        .string()
        .describe("ID of the page whose content will be injected when the command is invoked."),
      driveId: z
        .string()
        .optional()
        .describe(
          "Create a drive-scoped command visible to all drive members. Omit to create a personal command. Requires drive owner or admin role."
        ),
      enabled: z
        .boolean()
        .optional()
        .describe('Whether the command is immediately active. Defaults to true.'),
    }),
    execute: async (
      { trigger, description, entryPageId, driveId, enabled },
      { experimental_context: context }
    ) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      const triggerResult = validateCommandTrigger(trigger);
      if (!triggerResult.valid) throw new Error(triggerResult.error);
      if (isReservedTrigger(trigger)) throw new Error(`'${trigger}' is a reserved built-in trigger`);

      const descResult = validateCommandDescription(description);
      if (!descResult.valid) throw new Error(descResult.error);

      const commandDriveId = driveId ?? null;

      try {
        if (commandDriveId !== null) {
          const allowed = await isDriveOwnerOrAdmin(userId, commandDriveId);
          if (!allowed) throw new Error('Only the drive owner or admins can create drive commands');
        }

        await validateEntryPageForTool(userId, entryPageId, commandDriveId);

        const duplicate = await db.query.commands.findFirst({
          where: and(
            commandDriveId !== null
              ? eq(commands.driveId, commandDriveId)
              : eq(commands.userId, userId),
            eq(commands.trigger, trigger)
          ),
          columns: { id: true },
        });
        if (duplicate) {
          throw new Error(`A command with trigger '${trigger}' already exists in this scope`);
        }

        const [created] = await db
          .insert(commands)
          .values({
            userId: commandDriveId !== null ? null : userId,
            driveId: commandDriveId,
            createdById: userId,
            trigger,
            description,
            entryPageId,
            type: 'document',
            enabled: enabled ?? true,
          })
          .returning();

        return {
          success: true,
          commandId: created.id,
          trigger: created.trigger,
          description: created.description,
          scope: created.userId !== null ? 'user' : 'drive',
          driveId: created.driveId,
          entryPageId: created.entryPageId,
          enabled: created.enabled,
          message: `Command /${trigger} created successfully`,
        };
      } catch (error) {
        commandLogger.error('Failed to create command', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          trigger,
        });
        throw new Error(
          `Failed to create command: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  update_command: tool({
    description:
      "Update a slash command's trigger name, description, entry page, or enabled state. Use list_commands to find command IDs.",
    inputSchema: z.object({
      commandId: z.string().describe('ID of the command to update.'),
      trigger: z.string().optional().describe('New trigger name.'),
      description: z.string().optional().describe('New description.'),
      entryPageId: z.string().optional().describe('New entry page ID.'),
      enabled: z.boolean().optional().describe('Enable or disable the command.'),
    }),
    execute: async (
      { commandId, trigger, description, entryPageId, enabled },
      { experimental_context: context }
    ) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      if (
        trigger === undefined &&
        description === undefined &&
        entryPageId === undefined &&
        enabled === undefined
      ) {
        throw new Error(
          'At least one field (trigger, description, entryPageId, enabled) must be provided'
        );
      }

      if (trigger !== undefined) {
        const triggerResult = validateCommandTrigger(trigger);
        if (!triggerResult.valid) throw new Error(triggerResult.error);
        if (isReservedTrigger(trigger)) throw new Error(`'${trigger}' is a reserved built-in trigger`);
      }
      if (description !== undefined) {
        const descResult = validateCommandDescription(description);
        if (!descResult.valid) throw new Error(descResult.error);
      }

      try {
        const command = await loadCommandForManage(userId, commandId);

        if (typeof trigger === 'string' && trigger !== command.trigger) {
          const duplicate = await db.query.commands.findFirst({
            where: and(
              command.driveId !== null
                ? eq(commands.driveId, command.driveId)
                : eq(commands.userId, command.userId as string),
              eq(commands.trigger, trigger),
              ne(commands.id, command.id)
            ),
            columns: { id: true },
          });
          if (duplicate) {
            throw new Error(`A command with trigger '${trigger}' already exists in this scope`);
          }
        }

        if (typeof entryPageId === 'string') {
          await validateEntryPageForTool(userId, entryPageId, command.driveId);
        }

        const updateData: Partial<{
          trigger: string;
          description: string;
          entryPageId: string;
          enabled: boolean;
        }> = {};
        if (typeof trigger === 'string') updateData.trigger = trigger;
        if (typeof description === 'string') updateData.description = description;
        if (typeof entryPageId === 'string') updateData.entryPageId = entryPageId;
        if (typeof enabled === 'boolean') updateData.enabled = enabled;

        const [updated] = await db
          .update(commands)
          .set(updateData)
          .where(eq(commands.id, command.id))
          .returning();

        return {
          success: true,
          commandId: updated.id,
          trigger: updated.trigger,
          description: updated.description,
          scope: updated.userId !== null ? 'user' : 'drive',
          enabled: updated.enabled,
          updatedFields: Object.keys(updateData),
          message: `Command /${updated.trigger} updated`,
        };
      } catch (error) {
        commandLogger.error('Failed to update command', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          commandId: maskIdentifier(commandId),
        });
        throw new Error(
          `Failed to update command: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  delete_command: tool({
    description:
      'Delete a slash command registration. Removes the /trigger shortcut but does not affect the entry page. Use list_commands to find command IDs.',
    inputSchema: z.object({
      commandId: z.string().describe('ID of the command to delete.'),
    }),
    execute: async ({ commandId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      try {
        const command = await loadCommandForManage(userId, commandId);
        await db.delete(commands).where(eq(commands.id, command.id));

        return {
          success: true,
          trigger: command.trigger,
          message: `Command /${command.trigger} deleted`,
        };
      } catch (error) {
        commandLogger.error('Failed to delete command', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          commandId: maskIdentifier(commandId),
        });
        throw new Error(
          `Failed to delete command: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  list_commands: tool({
    description:
      'List slash commands available to you — your personal commands and drive commands for drives you belong to.',
    inputSchema: z.object({
      driveId: z
        .string()
        .optional()
        .describe(
          "Filter to a specific drive. Returns personal commands plus that drive's commands."
        ),
    }),
    execute: async ({ driveId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      try {
        const allMemberDriveIds = await getMemberDriveIds(userId);

        if (driveId && !allMemberDriveIds.includes(driveId)) {
          throw new Error('Drive not found or you are not a member of that drive');
        }

        const memberDriveIds = driveId ? [driveId] : allMemberDriveIds;

        const visible = await db.query.commands.findMany({
          where: memberDriveIds.length
            ? or(eq(commands.userId, userId), inArray(commands.driveId, memberDriveIds))
            : eq(commands.userId, userId),
        });

        const sorted = [...visible].sort((a, b) => a.trigger.localeCompare(b.trigger));

        return {
          commands: sorted.map((c) => ({
            id: c.id,
            trigger: c.trigger,
            description: c.description,
            scope: c.userId !== null ? 'user' : 'drive',
            driveId: c.driveId,
            enabled: c.enabled,
            entryPageId: c.entryPageId,
          })),
          total: sorted.length,
        };
      } catch (error) {
        commandLogger.error('Failed to list commands', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
        });
        throw new Error(
          `Failed to list commands: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),
};

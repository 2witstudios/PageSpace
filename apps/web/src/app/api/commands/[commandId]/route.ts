import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { and, eq, ne } from '@pagespace/db/operators';
import { commands } from '@pagespace/db/schema/commands';
import type { SelectCommand } from '@pagespace/db/schema/commands';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket/socket-utils';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import {
  validateCommandTrigger,
  validateCommandDescription,
  isReservedTrigger,
} from '@pagespace/lib/commands/command-core';
import {
  AUTH_OPTIONS_WRITE,
  toCommandResponse,
  isUniqueViolation,
  validateEntryPage,
} from '../command-route-helpers';

type RouteContext = { params: Promise<{ commandId: string }> };

/**
 * Load the command and authorize the caller to manage it.
 * Personal commands: only the owner (a 404 avoids leaking existence).
 * Drive commands: the drive's owner or an admin (403 otherwise).
 */
async function loadCommandForManage(
  userId: string,
  commandId: string
): Promise<{ command: SelectCommand } | { error: NextResponse }> {
  const command = await db.query.commands.findFirst({
    where: eq(commands.id, commandId),
  });

  if (!command) {
    return { error: NextResponse.json({ error: 'Command not found' }, { status: 404 }) };
  }

  if (command.userId !== null) {
    if (command.userId !== userId) {
      return { error: NextResponse.json({ error: 'Command not found' }, { status: 404 }) };
    }
    return { command };
  }

  const allowed = await isDriveOwnerOrAdmin(userId, command.driveId as string);
  if (!allowed) {
    return {
      error: NextResponse.json(
        { error: 'Only the drive owner or admins can manage drive commands' },
        { status: 403 }
      ),
    };
  }
  return { command };
}

// PATCH /api/commands/[commandId] - update trigger, description, entryPageId, enabled
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { commandId } = await context.params;

    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { trigger, description, entryPageId, enabled, userId: bodyUserId, driveId, type } =
      body as Record<string, unknown>;

    if (bodyUserId !== undefined || driveId !== undefined) {
      return NextResponse.json(
        { error: 'Command scope cannot be changed' },
        { status: 400 }
      );
    }
    if (type !== undefined && type !== 'document') {
      return NextResponse.json(
        { error: "Only 'document' commands are supported" },
        { status: 400 }
      );
    }
    if (
      trigger === undefined &&
      description === undefined &&
      entryPageId === undefined &&
      enabled === undefined
    ) {
      return NextResponse.json(
        { error: 'At least one field (trigger, description, entryPageId, enabled) is required' },
        { status: 400 }
      );
    }

    if (trigger !== undefined) {
      const triggerResult = validateCommandTrigger(trigger);
      if (!triggerResult.valid) {
        return NextResponse.json({ error: triggerResult.error }, { status: 400 });
      }
      if (isReservedTrigger(trigger as string)) {
        return NextResponse.json(
          { error: `'${trigger as string}' is a reserved built-in trigger` },
          { status: 400 }
        );
      }
    }
    if (description !== undefined) {
      const descriptionResult = validateCommandDescription(description);
      if (!descriptionResult.valid) {
        return NextResponse.json({ error: descriptionResult.error }, { status: 400 });
      }
    }
    if (entryPageId !== undefined && (typeof entryPageId !== 'string' || entryPageId.length === 0)) {
      return NextResponse.json({ error: 'entryPageId must be a non-empty string' }, { status: 400 });
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    const loaded = await loadCommandForManage(userId, commandId);
    if ('error' in loaded) return loaded.error;
    const command = loaded.command;

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
        return NextResponse.json(
          { error: `A command with trigger '${trigger}' already exists in this scope` },
          { status: 409 }
        );
      }
    }

    if (typeof entryPageId === 'string') {
      const entryPageError = await validateEntryPage(userId, entryPageId, command.driveId);
      if (entryPageError) return entryPageError;
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

    let updated;
    try {
      [updated] = await db
        .update(commands)
        .set(updateData)
        .where(eq(commands.id, command.id))
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) {
        return NextResponse.json(
          { error: `A command with trigger '${trigger as string}' already exists in this scope` },
          { status: 409 }
        );
      }
      throw error;
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'command',
      resourceId: command.id,
      details: { action: 'update', fields: Object.keys(updateData) },
    });

    if (command.driveId !== null) {
      try {
        const recipientUserIds = await getDriveRecipientUserIds(command.driveId);
        await broadcastDriveEvent(createDriveEventPayload(command.driveId, 'updated', { resourceType: 'command' }), recipientUserIds);
      } catch (broadcastError) {
        loggers.api.error('[COMMANDS_PATCH_BROADCAST]', broadcastError as Error);
      }
    }

    return NextResponse.json({ command: toCommandResponse(updated) });
  } catch (error) {
    loggers.api.error('[COMMANDS_PATCH]', error as Error);
    return NextResponse.json({ error: 'Failed to update command' }, { status: 500 });
  }
}

// DELETE /api/commands/[commandId]
export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { commandId } = await context.params;

    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const loaded = await loadCommandForManage(userId, commandId);
    if ('error' in loaded) return loaded.error;
    const command = loaded.command;

    await db.delete(commands).where(eq(commands.id, command.id));

    auditRequest(request, {
      eventType: 'data.delete',
      userId,
      resourceType: 'command',
      resourceId: command.id,
      details: {
        trigger: command.trigger,
        scope: command.userId !== null ? 'user' : 'drive',
        driveId: command.driveId,
      },
    });

    if (command.driveId !== null) {
      try {
        const recipientUserIds = await getDriveRecipientUserIds(command.driveId);
        await broadcastDriveEvent(createDriveEventPayload(command.driveId, 'updated', { resourceType: 'command' }), recipientUserIds);
      } catch (broadcastError) {
        loggers.api.error('[COMMANDS_DELETE_BROADCAST]', broadcastError as Error);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('[COMMANDS_DELETE]', error as Error);
    return NextResponse.json({ error: 'Failed to delete command' }, { status: 500 });
  }
}

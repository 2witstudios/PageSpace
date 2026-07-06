import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { and, eq, or, inArray, isNotNull } from '@pagespace/db/operators';
import { commands } from '@pagespace/db/schema/commands';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { users } from '@pagespace/db/schema/auth';
import { decryptUserRows } from '@pagespace/lib/auth/user-repository';
import { authenticateRequestWithOptions, isAuthError, filterDrivesByMCPScope, checkMCPDriveScope, canPrincipalViewPage } from '@/lib/auth';
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
  AUTH_OPTIONS_READ,
  AUTH_OPTIONS_WRITE,
  toCommandResponse,
  isUniqueViolation,
  validateEntryPage,
} from './command-route-helpers';

/** Drives where the user is owner or an accepted member (page-level access does not count). */
async function getMemberDriveIds(userId: string): Promise<string[]> {
  const driveIds = new Set<string>();

  const owned = await db
    .select({ id: drives.id })
    .from(drives)
    .where(and(eq(drives.ownerId, userId), eq(drives.isTrashed, false)));
  for (const drive of owned) {
    driveIds.add(drive.id);
  }

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
  for (const membership of memberships) {
    driveIds.add(membership.driveId);
  }

  return Array.from(driveIds);
}

// GET /api/commands - list commands visible to the caller:
// their personal commands + drive commands of drives they belong to
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const memberDriveIds = filterDrivesByMCPScope(auth, await getMemberDriveIds(userId));

    const visible = await db.query.commands.findMany({
      where: memberDriveIds.length
        ? or(eq(commands.userId, userId), inArray(commands.driveId, memberDriveIds))
        : eq(commands.userId, userId),
    });

    const sorted = [...visible].sort((a, b) => a.trigger.localeCompare(b.trigger));

    // Enrich for the settings lists: entry page title + availability, author name.
    const pageIds = Array.from(new Set(sorted.map((command) => command.entryPageId)));
    const entryPages = pageIds.length
      ? await db.query.pages.findMany({
          where: inArray(pages.id, pageIds),
          columns: { id: true, title: true, driveId: true, isTrashed: true },
        })
      : [];
    const pageById = new Map(entryPages.map((page) => [page.id, page]));

    // Drive membership does NOT imply page access (private pages need explicit
    // permission), so every entry page gets a real permission check. Pages the
    // caller can't view have their metadata suppressed entirely — drive
    // commands are listed to all members, and the title of a private entry
    // page must not leak through this endpoint.
    const viewableByPageId = new Map(
      await Promise.all(
        entryPages.map(
          async (page) => [page.id, await canPrincipalViewPage(auth, page.id)] as const
        )
      )
    );

    const authorIds = Array.from(
      new Set(
        sorted
          .map((command) => command.createdById)
          .filter((id): id is string => id !== null)
      )
    );
    const authors = authorIds.length
      ? await db.query.users.findMany({
          where: inArray(users.id, authorIds),
          columns: { id: true, name: true },
        })
      : [];
    const decryptedAuthors = await decryptUserRows(authors);
    const authorNameById = new Map(decryptedAuthors.map((author) => [author.id, author.name]));

    return NextResponse.json({
      commands: sorted.map((command) => {
        const page = pageById.get(command.entryPageId);
        const viewable = viewableByPageId.get(command.entryPageId) ?? false;
        return {
          ...toCommandResponse(command),
          entryPageTitle: viewable && page ? page.title : null,
          entryPageDriveId: viewable && page ? page.driveId : null,
          entryPageAvailable: viewable && page !== undefined && !page.isTrashed,
          authorName:
            command.createdById !== null
              ? authorNameById.get(command.createdById) ?? null
              : null,
        };
      }),
    });
  } catch (error) {
    loggers.api.error('[COMMANDS_GET]', error as Error);
    return NextResponse.json({ error: 'Failed to list commands' }, { status: 500 });
  }
}

// POST /api/commands - create a personal command (no driveId) or a drive
// command (driveId present; caller must be the drive's owner or an admin)
export async function POST(request: Request) {
  try {
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

    const { trigger, description, entryPageId, driveId, type, enabled } = body as Record<
      string,
      unknown
    >;

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

    const descriptionResult = validateCommandDescription(description);
    if (!descriptionResult.valid) {
      return NextResponse.json({ error: descriptionResult.error }, { status: 400 });
    }

    if (typeof entryPageId !== 'string' || entryPageId.length === 0) {
      return NextResponse.json({ error: 'entryPageId is required' }, { status: 400 });
    }
    if (driveId !== undefined && (typeof driveId !== 'string' || driveId.length === 0)) {
      return NextResponse.json({ error: 'driveId must be a non-empty string' }, { status: 400 });
    }
    if (type !== undefined && type !== 'document') {
      return NextResponse.json(
        { error: "Only 'document' commands are supported" },
        { status: 400 }
      );
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    const commandDriveId = typeof driveId === 'string' ? driveId : null;

    if (commandDriveId !== null) {
      const scopeError = checkMCPDriveScope(auth, commandDriveId);
      if (scopeError) return scopeError;
      const allowed = await isDriveOwnerOrAdmin(userId, commandDriveId);
      if (!allowed) {
        return NextResponse.json(
          { error: 'Only the drive owner or admins can manage drive commands' },
          { status: 403 }
        );
      }
    }

    const entryPageError = await validateEntryPage(auth, entryPageId, commandDriveId);
    if (entryPageError) return entryPageError;

    const duplicate = await db.query.commands.findFirst({
      where: and(
        commandDriveId !== null
          ? eq(commands.driveId, commandDriveId)
          : eq(commands.userId, userId),
        eq(commands.trigger, trigger as string)
      ),
      columns: { id: true },
    });
    if (duplicate) {
      return NextResponse.json(
        { error: `A command with trigger '${trigger as string}' already exists in this scope` },
        { status: 409 }
      );
    }

    let created;
    try {
      [created] = await db
        .insert(commands)
        .values({
          userId: commandDriveId !== null ? null : userId,
          driveId: commandDriveId,
          createdById: userId,
          trigger: trigger as string,
          description: description as string,
          entryPageId,
          type: 'document',
          enabled: enabled === undefined ? true : enabled,
        })
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
      resourceId: created.id,
      details: {
        action: 'create',
        trigger: created.trigger,
        scope: created.userId !== null ? 'user' : 'drive',
        driveId: created.driveId,
      },
    });

    if (commandDriveId !== null) {
      try {
        const recipientUserIds = await getDriveRecipientUserIds(commandDriveId);
        await broadcastDriveEvent(createDriveEventPayload(commandDriveId, 'updated', { resourceType: 'command' }), recipientUserIds);
      } catch (broadcastError) {
        loggers.api.error('[COMMANDS_POST_BROADCAST]', broadcastError as Error);
      }
    }

    return NextResponse.json({ command: toCommandResponse(created) }, { status: 201 });
  } catch (error) {
    loggers.api.error('[COMMANDS_POST]', error as Error);
    return NextResponse.json({ error: 'Failed to create command' }, { status: 500 });
  }
}

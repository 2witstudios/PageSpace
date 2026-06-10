import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { and, eq, or, inArray, isNotNull } from '@pagespace/db/operators';
import { commands } from '@pagespace/db/schema/commands';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { users } from '@pagespace/db/schema/auth';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { canUserViewPage, isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
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

    const memberDriveIds = await getMemberDriveIds(userId);

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

    // A page in one of the caller's drives is always viewable; pages reached
    // through page-level shares need the (rarer) per-page permission check.
    const memberDriveIdSet = new Set(memberDriveIds);
    const availabilityByPageId = new Map<string, boolean>();
    for (const page of entryPages) {
      if (page.isTrashed) {
        availabilityByPageId.set(page.id, false);
      } else if (memberDriveIdSet.has(page.driveId)) {
        availabilityByPageId.set(page.id, true);
      } else {
        availabilityByPageId.set(page.id, await canUserViewPage(userId, page.id));
      }
    }

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
    const authorNameById = new Map(authors.map((author) => [author.id, author.name]));

    return NextResponse.json({
      commands: sorted.map((command) => {
        const page = pageById.get(command.entryPageId);
        return {
          ...toCommandResponse(command),
          entryPageTitle: page?.title ?? null,
          entryPageDriveId: page?.driveId ?? null,
          entryPageAvailable: availabilityByPageId.get(command.entryPageId) ?? false,
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
      const allowed = await isDriveOwnerOrAdmin(userId, commandDriveId);
      if (!allowed) {
        return NextResponse.json(
          { error: 'Only the drive owner or admins can manage drive commands' },
          { status: 403 }
        );
      }
    }

    const entryPageError = await validateEntryPage(userId, entryPageId, commandDriveId);
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

    return NextResponse.json({ command: toCommandResponse(created) }, { status: 201 });
  } catch (error) {
    loggers.api.error('[COMMANDS_POST]', error as Error);
    return NextResponse.json({ error: 'Failed to create command' }, { status: 500 });
  }
}

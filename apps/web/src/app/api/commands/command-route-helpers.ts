import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import type { SelectCommand } from '@pagespace/db/schema/commands';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import type { CommandScope } from '@pagespace/lib/commands/command-core';

export const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
export const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export interface CommandResponse {
  id: string;
  scope: CommandScope;
  driveId: string | null;
  trigger: string;
  description: string;
  entryPageId: string;
  type: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * List-enriched command shape returned by GET /api/commands — adds what the
 * settings lists render: entry page title + availability and the author name
 * for drive command rows ("Added by {name}").
 */
export interface CommandListItem extends CommandResponse {
  entryPageTitle: string | null;
  entryPageDriveId: string | null;
  entryPageAvailable: boolean;
  authorName: string | null;
}

export function toCommandResponse(command: SelectCommand): CommandResponse {
  return {
    id: command.id,
    scope: command.userId !== null ? 'user' : 'drive',
    driveId: command.driveId,
    trigger: command.trigger,
    description: command.description,
    entryPageId: command.entryPageId,
    type: command.type,
    enabled: command.enabled,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
  };
}

/** Postgres unique_violation, possibly wrapped by the driver/ORM. */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === '23505') return true;
  return isUniqueViolation(candidate.cause);
}

/**
 * Validate an entry page reference before any write: it must exist, not be
 * trashed, be viewable by the caller, and (for drive commands) live in the
 * command's drive. Returns an error response to send, or null when valid.
 * Every id is checked against the DB up front — an unvalidated FK write
 * destroys the whole request with a 500.
 */
export async function validateEntryPage(
  userId: string,
  entryPageId: string,
  commandDriveId: string | null
): Promise<NextResponse | null> {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, entryPageId),
    columns: { id: true, driveId: true, isTrashed: true },
  });

  if (!page) {
    return NextResponse.json({ error: 'Entry page not found' }, { status: 400 });
  }
  if (page.isTrashed) {
    return NextResponse.json({ error: 'Entry page is in the trash' }, { status: 400 });
  }

  const canView = await canUserViewPage(userId, entryPageId);
  if (!canView) {
    return NextResponse.json(
      { error: 'You do not have access to the entry page' },
      { status: 403 }
    );
  }

  if (commandDriveId !== null && page.driveId !== commandDriveId) {
    return NextResponse.json(
      { error: "A drive command's entry page must be in the same drive" },
      { status: 400 }
    );
  }

  return null;
}

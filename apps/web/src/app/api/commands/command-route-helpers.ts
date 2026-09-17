import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import type { SelectCommand } from '@pagespace/db/schema/commands';
import { canPrincipalViewPage, isDriveScopedPrincipal, isPrincipalDriveOwnerOrAdmin, type AuthResult } from '@/lib/auth';
import type { CommandScope } from '@pagespace/lib/commands/command-core';

export const AUTH_OPTIONS_READ = { allow: ['session', 'mcp', 'oauth'] as const, requireCSRF: false };
export const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp', 'oauth'] as const, requireCSRF: true };

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

/**
 * Whether the caller may manage a DRIVE command: owner/admin authority for the
 * credential, which the resolver caps at its user as the user stands now — a
 * user demoted ADMIN→MEMBER stops managing commands through an ADMIN key or grant.
 */
export async function canManageDriveCommands(auth: AuthResult, driveId: string): Promise<boolean> {
  return isPrincipalDriveOwnerOrAdmin(auth, driveId);
}

/**
 * A drive-scoped credential (mcp_ key or OAuth grant) acts within its drives only:
 * a PERSONAL command belongs to the user across every drive, so it may not be
 * created, changed or deleted through one. Constant 403; null when allowed.
 */
export function refuseScopedPersonalCommand(auth: AuthResult): NextResponse | null {
  if (!isDriveScopedPrincipal(auth)) return null;
  return NextResponse.json({ error: 'Drive-scoped credentials cannot manage personal commands' }, { status: 403 });
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
  auth: AuthResult,
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

  const canView = await canPrincipalViewPage(auth, entryPageId);
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

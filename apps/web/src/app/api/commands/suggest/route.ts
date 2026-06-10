import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { commands } from '@pagespace/db/schema/commands';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import {
  BUILTIN_COMMANDS,
  resolveCommandPrecedence,
  COMMAND_TRIGGER_MAX_LENGTH,
  type CommandScope,
  type CommandSummary,
} from '@pagespace/lib/commands/command-core';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

const driveIdSchema = z.string().min(1, 'driveId must not be empty').max(100);

interface CommandSuggestion {
  id: string;
  trigger: string;
  description: string;
  scope: CommandScope;
  shadows?: CommandScope;
}

// GET /api/commands/suggest?q=&driveId= - precedence-resolved merged command
// list: built-ins from the lib registry + the caller's personal commands +
// (when driveId is given and the caller is a member) that drive's commands.
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { searchParams } = new URL(request.url);
  // Triggers are at most 64 chars, so anything longer can never match
  const q = (searchParams.get('q') ?? '')
    .trim()
    .toLowerCase()
    .slice(0, COMMAND_TRIGGER_MAX_LENGTH);
  const driveId = searchParams.get('driveId');

  if (driveId !== null && driveId !== '') {
    const driveIdValidation = driveIdSchema.safeParse(driveId);
    if (!driveIdValidation.success) {
      return NextResponse.json({ error: 'Invalid driveId format' }, { status: 400 });
    }
  }

  try {
    if (driveId) {
      const isMember = await isUserDriveMember(userId, driveId);
      if (!isMember) {
        return NextResponse.json(
          { error: 'Access denied to the specified drive' },
          { status: 403 }
        );
      }
    }

    const builtins: CommandSummary[] = BUILTIN_COMMANDS.map((builtin) => ({
      id: `builtin:${builtin.trigger}`,
      trigger: builtin.trigger,
      description: builtin.description,
      scope: 'builtin',
      type: 'builtin',
    }));

    // Entry pages are loaded alongside each command so save-time invariants
    // are re-checked at use: a trashed entry page suppresses the suggestion,
    // and a drive command whose entry page has since moved to another drive
    // (e.g. via bulk-move) is suppressed rather than offered while broken.
    type EntryPageRef = { driveId: string; isTrashed: boolean };
    const hasLiveEntryPage = <T extends { entryPage: EntryPageRef | null }>(
      row: T
    ): row is T & { entryPage: EntryPageRef } =>
      row.entryPage !== null && !row.entryPage.isTrashed;

    const personalRows = await db.query.commands.findMany({
      where: and(eq(commands.userId, userId), eq(commands.enabled, true)),
      with: { entryPage: { columns: { driveId: true, isTrashed: true } } },
    });
    const userCommands: CommandSummary[] = personalRows
      .filter(hasLiveEntryPage)
      .map((row) => ({
        id: row.id,
        trigger: row.trigger,
        description: row.description,
        scope: 'user',
        type: row.type as CommandSummary['type'],
        entryPageId: row.entryPageId,
      }));

    let driveCommands: CommandSummary[] = [];
    if (driveId) {
      const driveRows = await db.query.commands.findMany({
        where: and(eq(commands.driveId, driveId), eq(commands.enabled, true)),
        with: { entryPage: { columns: { driveId: true, isTrashed: true } } },
      });
      driveCommands = driveRows
        .filter((row) => hasLiveEntryPage(row) && row.entryPage.driveId === driveId)
        .map((row) => ({
          id: row.id,
          trigger: row.trigger,
          description: row.description,
          scope: 'drive',
          type: row.type as CommandSummary['type'],
          entryPageId: row.entryPageId,
          driveId: row.driveId ?? undefined,
        }));
    }

    const { winners } = resolveCommandPrecedence(builtins, userCommands, driveCommands);

    // q matching happens in JS over the caller's own small command set, so user
    // input never reaches a SQL LIKE pattern
    const filtered = q ? winners.filter((winner) => winner.trigger.includes(q)) : winners;
    const ranked = [...filtered].sort((a, b) => {
      if (q) {
        const aPrefix = a.trigger.startsWith(q) ? 0 : 1;
        const bPrefix = b.trigger.startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      }
      return a.trigger.localeCompare(b.trigger);
    });

    const suggestions: CommandSuggestion[] = ranked.map((winner) => ({
      id: winner.id,
      trigger: winner.trigger,
      description: winner.description,
      scope: winner.scope,
      ...(winner.shadows !== undefined ? { shadows: winner.shadows } : {}),
    }));

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'command',
      resourceId: driveId ?? '*',
      details: { source: 'suggest', resultCount: suggestions.length },
    });

    return NextResponse.json({ suggestions });
  } catch (error) {
    loggers.api.error('[COMMANDS_SUGGEST_GET]', error as Error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

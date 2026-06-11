import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import {
  COMMAND_TRIGGER_MAX_LENGTH,
  type CommandScope,
} from '@pagespace/lib/commands/command-core';
import { loadAvailableCommands } from '@/lib/commands/available-commands';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

const driveIdSchema = z.string().min(1, 'driveId must not be empty').max(100);

interface CommandSuggestion {
  id: string;
  trigger: string;
  description: string;
  scope: CommandScope;
  shadows?: CommandScope;
  /** Set on a shadowed (losing) command: the scope of the command that wins. */
  shadowedBy?: CommandScope;
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

    // Shared with the /help built-in injection (available-commands.ts) so the
    // picker and the AI's command list can never drift apart. Membership for
    // driveId was verified above — the loader requires that contract.
    const { winners, shadowed } = await loadAvailableCommands(userId, driveId || null);

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

    // Shadowed (losing) commands are included so the picker can render them
    // dimmed with a shadow indicator (UX spec §1.4/§1.6). `shadowedBy` carries
    // the winning command's scope for the indicator tooltip.
    const winnerScopeByTrigger = new Map(winners.map((w) => [w.trigger, w.scope]));
    const shadowedFiltered = q
      ? shadowed.filter((command) => command.trigger.includes(q))
      : shadowed;
    const shadowedRanked = [...shadowedFiltered].sort((a, b) =>
      a.trigger.localeCompare(b.trigger)
    );

    const suggestions: CommandSuggestion[] = [
      ...ranked.map((winner) => ({
        id: winner.id,
        trigger: winner.trigger,
        description: winner.description,
        scope: winner.scope,
        ...(winner.shadows !== undefined ? { shadows: winner.shadows } : {}),
      })),
      ...shadowedRanked.map((command) => ({
        id: command.id,
        trigger: command.trigger,
        description: command.description,
        scope: command.scope,
        shadowedBy: winnerScopeByTrigger.get(command.trigger) ?? ('builtin' as CommandScope),
      })),
    ];

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

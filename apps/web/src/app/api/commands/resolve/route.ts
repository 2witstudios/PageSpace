import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { commands } from '@pagespace/db/schema/commands';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { BUILTIN_COMMANDS } from '@pagespace/lib/commands/command-core';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

/** DB command ids are cuid2-style; built-ins are `builtin:{trigger}`. */
const DB_ID_PATTERN = /^[a-z0-9]{10,40}$/;
const BUILTIN_ID_PATTERN = /^builtin:[a-z0-9-]{1,64}$/;
const MAX_IDS = 50;

/**
 * Viewer-scoped chip resolution (UX spec §5). `restricted` means the command
 * exists but the viewer may not see its metadata (someone else's personal
 * command, or a drive the viewer isn't in) — the chip renders from its
 * stored label only. Trigger + description are returned only to viewers who
 * could resolve the command themselves (owner / drive member / built-in).
 */
type CommandResolution =
  | { state: 'deleted' }
  | { state: 'restricted' }
  | {
      state: 'ok';
      trigger: string;
      description: string;
      scope: 'builtin' | 'user' | 'drive';
      enabled: boolean;
      entryPageId?: string;
      entryPageTrashed: boolean;
      viewerCanViewEntryPage: boolean;
    };

// GET /api/commands/resolve?ids=a,b,c — batch chip-state resolution for
// transcript rendering. Ids come from message content (client-controlled):
// malformed ids resolve as `deleted` and never reach the DB query.
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { searchParams } = new URL(request.url);
  const rawIds = (searchParams.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const ids = [...new Set(rawIds)];

  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids is required' }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ error: `At most ${MAX_IDS} ids per request` }, { status: 400 });
  }

  try {
    const results: Record<string, CommandResolution> = {};
    const dbIds: string[] = [];

    for (const id of ids) {
      if (BUILTIN_ID_PATTERN.test(id)) {
        const trigger = id.slice('builtin:'.length);
        const builtin = BUILTIN_COMMANDS.find((command) => command.trigger === trigger);
        results[id] = builtin
          ? {
              state: 'ok',
              trigger: builtin.trigger,
              description: builtin.description,
              scope: 'builtin',
              enabled: true,
              entryPageTrashed: false,
              viewerCanViewEntryPage: false,
            }
          : { state: 'deleted' };
      } else if (DB_ID_PATTERN.test(id)) {
        dbIds.push(id);
      } else {
        results[id] = { state: 'deleted' };
      }
    }

    if (dbIds.length > 0) {
      const rows = await db.query.commands.findMany({
        where: inArray(commands.id, dbIds),
        with: { entryPage: { columns: { id: true, isTrashed: true } } },
      });
      const rowsById = new Map(rows.map((row) => [row.id, row]));

      for (const id of dbIds) {
        const row = rowsById.get(id);
        if (!row) {
          results[id] = { state: 'deleted' };
          continue;
        }

        const viewerCanSeeCommand = row.userId
          ? row.userId === userId
          : row.driveId
            ? await isUserDriveMember(userId, row.driveId)
            : false;

        if (!viewerCanSeeCommand) {
          results[id] = { state: 'restricted' };
          continue;
        }

        const entryPageTrashed = !row.entryPage || row.entryPage.isTrashed;
        const viewerCanViewEntryPage = entryPageTrashed
          ? false
          : await canUserViewPage(userId, row.entryPageId);

        results[id] = {
          state: 'ok',
          trigger: row.trigger,
          description: row.description,
          scope: row.userId ? 'user' : 'drive',
          enabled: row.enabled,
          entryPageId: row.entryPageId,
          entryPageTrashed,
          viewerCanViewEntryPage,
        };
      }
    }

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'command',
      resourceId: '*',
      details: { source: 'resolve', idCount: ids.length },
    });

    return NextResponse.json({ results });
  } catch (error) {
    loggers.api.error('[COMMANDS_RESOLVE_GET]', error as Error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

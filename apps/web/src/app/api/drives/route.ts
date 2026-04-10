import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listAccessibleDrives, createDrive } from '@pagespace/lib/server';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { loggers, securityAudit } from '@pagespace/lib/server';
import { trackDriveOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError, filterDrivesByMCPScope, checkMCPCreateScope } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/api-utils';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';
import { safeParseBody } from '@/lib/validation/parse-body';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const createDriveSchema = z.object({
  name: z.preprocess(
    (v) => (typeof v === 'string' ? v : ''),
    z.string().min(1, 'Missing name')
  ),
});

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;
  loggers.api.debug('[DEBUG] Drives API - User ID:', { userId });

  const url = new URL(req.url);
  const includeTrash = url.searchParams.get('includeTrash') === 'true';
  const tokenScopable = url.searchParams.get('tokenScopable') === 'true';

  try {
    const allDrives = await listAccessibleDrives(userId, { includeTrash, tokenScopable });

    // Filter drives by MCP token scope (no-op for session auth or unscoped tokens)
    const allowedDriveIds = filterDrivesByMCPScope(auth, allDrives.map(d => d.id));
    const allowedSet = new Set(allowedDriveIds);
    const drives = allDrives.filter(d => allowedSet.has(d.id));

    loggers.api.debug('[DEBUG] Drives API - Found drives:', {
      count: drives.length,
      drives: drives.map((d) => ({ id: d.id, name: d.name, slug: d.slug })),
    });

    return jsonResponse(drives);
  } catch (error) {
    loggers.api.error('Error fetching drives:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch drives' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  // Scoped MCP tokens cannot create new drives
  const scopeError = checkMCPCreateScope(auth, null);
  if (scopeError) {
    return scopeError;
  }

  const userId = auth.userId;

  const parsed = await safeParseBody(request, createDriveSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  const { name } = parsed.data;

  try {
    if (name.toLowerCase() === 'personal') {
      return NextResponse.json({ error: 'Cannot create a drive named "Personal".' }, { status: 400 });
    }

    const newDrive = await createDrive(userId, { name });

    await broadcastDriveEvent(
      createDriveEventPayload(newDrive.id, 'created', {
        name: newDrive.name,
        slug: newDrive.slug,
      }),
      [userId] // Only the creator receives the event for new drives
    );

    trackDriveOperation(userId, 'create', newDrive.id, {
      name: newDrive.name,
      slug: newDrive.slug,
    });

    // Log activity for audit trail
    const actorInfo = await getActorInfo(userId);
    logDriveActivity(userId, 'create', {
      id: newDrive.id,
      name: newDrive.name,
    }, actorInfo);

    securityAudit.logDataAccess(userId, 'write', 'drive', newDrive.id, { name, operation: 'create' })?.catch(() => {});

    return jsonResponse(newDrive, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating drive:', error as Error);
    return NextResponse.json({ error: 'Failed to create drive' }, { status: 500 });
  }
}

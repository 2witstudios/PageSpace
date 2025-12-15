import { NextResponse } from 'next/server';
import { listAccessibleDrives, createDrive } from '@pagespace/lib/server';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/server';
import { trackDriveOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/api-utils';

const AUTH_OPTIONS_READ = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;
  loggers.api.debug('[DEBUG] Drives API - User ID:', { userId });

  const url = new URL(req.url);
  const includeTrash = url.searchParams.get('includeTrash') === 'true';

  try {
    const drives = await listAccessibleDrives(userId, { includeTrash });

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

  const userId = auth.userId;

  try {
    const { name } = await request.json();

    if (!name) {
      return NextResponse.json({ error: 'Missing name' }, { status: 400 });
    }

    if (name.toLowerCase() === 'personal') {
      return NextResponse.json({ error: 'Cannot create a drive named "Personal".' }, { status: 400 });
    }

    const newDrive = await createDrive(userId, { name });

    await broadcastDriveEvent(
      createDriveEventPayload(newDrive.id, 'created', {
        name: newDrive.name,
        slug: newDrive.slug,
      }),
    );

    trackDriveOperation(userId, 'create', newDrive.id, {
      name: newDrive.name,
      slug: newDrive.slug,
    });

    return jsonResponse(newDrive, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating drive:', error as Error);
    return NextResponse.json({ error: 'Failed to create drive' }, { status: 500 });
  }
}

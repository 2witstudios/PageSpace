import { NextResponse } from 'next/server';
import { db, drives, pages, driveMembers, pagePermissions, eq, and, inArray, not } from '@pagespace/db';
import { slugify } from '@pagespace/lib/server';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket/socket-utils';
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

  // Check if we should include trashed drives
  const url = new URL(req.url);
  const includeTrash = url.searchParams.get('includeTrash') === 'true';

  try {
    const ownedDrives = await db.query.drives.findMany({
      where: includeTrash
        ? eq(drives.ownerId, userId)
        : and(eq(drives.ownerId, userId), eq(drives.isTrashed, false)),
    });

    const memberDrives = await db
      .selectDistinct({ driveId: driveMembers.driveId, role: driveMembers.role })
      .from(driveMembers)
      .where(eq(driveMembers.userId, userId));

    const permissionDrives = await db
      .selectDistinct({ driveId: pages.driveId })
      .from(pagePermissions)
      .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
      .where(and(eq(pagePermissions.userId, userId), eq(pagePermissions.canView, true)));

    const allSharedDriveIds = new Set<string>();
    const driveRoles = new Map<string, 'OWNER' | 'ADMIN' | 'MEMBER'>();

    memberDrives.forEach((d) => {
      if (d.driveId) {
        allSharedDriveIds.add(d.driveId);
        driveRoles.set(d.driveId, d.role as 'OWNER' | 'ADMIN' | 'MEMBER');
      }
    });
    permissionDrives.forEach((d) => {
      if (d.driveId) {
        allSharedDriveIds.add(d.driveId);
        // If not already a member, set as MEMBER role by default
        if (!driveRoles.has(d.driveId)) {
          driveRoles.set(d.driveId, 'MEMBER');
        }
      }
    });

    const sharedDriveIds = Array.from(allSharedDriveIds);

    const sharedDrives = sharedDriveIds.length
      ? await db.query.drives.findMany({
          where: includeTrash
            ? and(inArray(drives.id, sharedDriveIds), not(eq(drives.ownerId, userId)))
            : and(
                inArray(drives.id, sharedDriveIds),
                not(eq(drives.ownerId, userId)),
                eq(drives.isTrashed, false),
              ),
        })
      : [];

    const allDrives = [
      ...ownedDrives.map((drive) => ({ ...drive, isOwned: true, role: 'OWNER' as const })),
      ...sharedDrives.map((drive) => ({
        ...drive,
        isOwned: false,
        role: driveRoles.get(drive.id) || 'MEMBER' as 'OWNER' | 'ADMIN' | 'MEMBER'
      })),
    ];

    const uniqueDrives = Array.from(new Map(allDrives.map((d) => [d.id, d])).values());

    loggers.api.debug('[DEBUG] Drives API - Found drives:', {
      count: uniqueDrives.length,
      drives: uniqueDrives.map((d) => ({ id: d.id, name: d.name, slug: d.slug })),
    });

    return jsonResponse(uniqueDrives);
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

  const session = { user: { id: auth.userId } };

  try {
    const { name } = await request.json();

    if (!name) {
      return NextResponse.json({ error: 'Missing name' }, { status: 400 });
    }

    if (name.toLowerCase() === 'personal') {
      return NextResponse.json({ error: 'Cannot create a drive named "Personal".' }, { status: 400 });
    }

    const slug = slugify(name);

    const newDrive = await db
      .insert(drives)
      .values({
        name,
        slug,
        ownerId: session.user.id,
        isTrashed: false,
        trashedAt: null,
        updatedAt: new Date(),
      })
      .returning();

    await broadcastDriveEvent(
      createDriveEventPayload(newDrive[0].id, 'created', {
        name: newDrive[0].name,
        slug: newDrive[0].slug,
      }),
    );

    trackDriveOperation(auth.userId, 'create', newDrive[0].id, {
      name: newDrive[0].name,
      slug: newDrive[0].slug,
    });

    return jsonResponse({ ...newDrive[0], isOwned: true, role: 'OWNER' as const }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating drive:', error as Error);
    return NextResponse.json({ error: 'Failed to create drive' }, { status: 500 });
  }
}

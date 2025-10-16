import { NextResponse } from 'next/server';
import { pages, users, pagePermissions, driveMembers, db, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getUserAccessLevel } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod/v4';
import { createPermissionNotification } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { pageId } = await params;

  try {
    // SECURITY: Check if user has permission to view the permission list
    // Only users with canShare permission can see who has access to a page
    const accessLevel = await getUserAccessLevel(userId, pageId);

    if (!accessLevel?.canShare) {
      loggers.api.warn('Unauthorized permission list access attempt', {
        userId,
        pageId,
        hasAccess: !!accessLevel,
        canShare: accessLevel?.canShare || false
      });
      return NextResponse.json(
        {
          error: 'You need share permission to view the permission list for this page',
          details: 'Only users who can manage permissions can view who has access'
        },
        { status: 403 }
      );
    }

    const pageWithDrive = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: {
        drive: {
          with: {
            owner: {
              columns: { id: true, name: true, email: true, image: true },
            },
          },
        },
      },
    });

    if (!pageWithDrive) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    // Fetch permissions using new table
    const permissions = await db.select({
      id: pagePermissions.id,
      userId: pagePermissions.userId,
      canView: pagePermissions.canView,
      canEdit: pagePermissions.canEdit,
      canShare: pagePermissions.canShare,
      canDelete: pagePermissions.canDelete,
      grantedBy: pagePermissions.grantedBy,
      grantedAt: pagePermissions.grantedAt,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      }
    })
    .from(pagePermissions)
    .leftJoin(users, eq(pagePermissions.userId, users.id))
    .where(eq(pagePermissions.pageId, pageId));

    return NextResponse.json({
      owner: pageWithDrive.drive.owner,
      permissions: permissions.map(p => ({
        id: p.id,
        userId: p.userId,
        canView: p.canView,
        canEdit: p.canEdit,
        canShare: p.canShare,
        canDelete: p.canDelete,
        grantedBy: p.grantedBy,
        grantedAt: p.grantedAt,
        user: p.user,
      })),
    });
  } catch (error) {
    loggers.api.error('Error fetching permissions:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch permissions' },
      { status: 500 }
    );
  }
}

const postSchema = z.object({
  userId: z.string(),
  canView: z.boolean().default(false),
  canEdit: z.boolean().default(false),
  canShare: z.boolean().default(false),
  canDelete: z.boolean().default(false),
});

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const currentUserId = auth.userId;

  const { pageId } = await params;

  try {
    const body = await req.json();
    const { userId, canView, canEdit, canShare, canDelete } = postSchema.parse(body);

    // Check if user has permission to share this page
    const currentUserPermission = await db.query.pagePermissions.findFirst({
      where: and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, currentUserId)
      )
    });

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: { drive: true }
    });

    // Check if user is owner or admin or has share permission
    const isOwner = page?.drive?.ownerId === currentUserId;
    let isAdmin = false;

    if (!isOwner && page?.drive?.id) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, page.drive.id),
          eq(driveMembers.userId, currentUserId),
          eq(driveMembers.role, 'ADMIN')
        ))
        .limit(1);

      isAdmin = adminMembership.length > 0;
    }

    const canGrantPermission = isOwner || isAdmin || currentUserPermission?.canShare;

    if (!canGrantPermission) {
      return NextResponse.json({ error: 'You do not have permission to share this page' }, { status: 403 });
    }

    // Check if permission already exists
    const existing = await db.query.pagePermissions.findFirst({
      where: and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, userId)
      )
    });

    if (existing) {
      // Update existing permission
      const updated = await db.update(pagePermissions)
        .set({ canView, canEdit, canShare, canDelete })
        .where(eq(pagePermissions.id, existing.id))
        .returning();
      
      // Send notification for permission update
      await createPermissionNotification(
        userId,
        pageId,
        'updated',
        { canView, canEdit, canShare, canDelete },
        currentUserId
      );
      
      return NextResponse.json(updated[0]);
    }

    // Create new permission
    const newPermission = await db.insert(pagePermissions).values({
      id: createId(),
      pageId,
      userId,
      canView,
      canEdit,
      canShare,
      canDelete,
      grantedBy: currentUserId,
      grantedAt: new Date(),
    }).returning();

    // Send notification for new permission
    await createPermissionNotification(
      userId,
      pageId,
      'granted',
      { canView, canEdit, canShare, canDelete },
      currentUserId
    );

    return NextResponse.json(newPermission[0], { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating permission:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to create permission' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const currentUserId = auth.userId;

  const { pageId } = await params;

  try {
    const { userId } = await req.json();

    // Check if user has permission to manage this page
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: { drive: true }
    });

    const isOwner = page?.drive?.ownerId === currentUserId;
    let isAdmin = false;

    if (!isOwner && page?.drive?.id) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, page.drive.id),
          eq(driveMembers.userId, currentUserId),
          eq(driveMembers.role, 'ADMIN')
        ))
        .limit(1);

      isAdmin = adminMembership.length > 0;
    }

    if (!isOwner && !isAdmin) {
      const currentUserPermission = await db.query.pagePermissions.findFirst({
        where: and(
          eq(pagePermissions.pageId, pageId),
          eq(pagePermissions.userId, currentUserId)
        )
      });

      if (!currentUserPermission?.canShare) {
        return NextResponse.json({ error: 'You do not have permission to manage this page' }, { status: 403 });
      }
    }

    // Delete the permission
    await db.delete(pagePermissions)
      .where(and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, userId)
      ));

    // Send notification for permission revoked
    await createPermissionNotification(
      userId,
      pageId,
      'revoked',
      {},
      currentUserId
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting permission:', error as Error);
    return NextResponse.json({ error: 'Failed to delete permission' }, { status: 500 });
  }
}
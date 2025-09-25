import { NextResponse } from 'next/server';
import { pages, users, pagePermissions, db, eq, and } from '@pagespace/db';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod/v4';
import { createPermissionNotification } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded || !decoded.userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
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
  const { pageId } = await params;
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded || !decoded.userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const body = await req.json();
    const { userId, canView, canEdit, canShare, canDelete } = postSchema.parse(body);

    // Check if user has permission to share this page
    const currentUserPermission = await db.query.pagePermissions.findFirst({
      where: and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, decoded.userId)
      )
    });

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: { drive: true }
    });

    // Check if user is owner or has share permission
    const isOwner = page?.drive?.ownerId === decoded.userId;
    const canGrantPermission = isOwner || currentUserPermission?.canShare;

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
        decoded.userId
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
      grantedBy: decoded.userId,
      grantedAt: new Date(),
    }).returning();

    // Send notification for new permission
    await createPermissionNotification(
      userId,
      pageId,
      'granted',
      { canView, canEdit, canShare, canDelete },
      decoded.userId
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
  const { pageId } = await params;
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded || !decoded.userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const { userId } = await req.json();

    // Check if user has permission to manage this page
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: { drive: true }
    });

    const isOwner = page?.drive?.ownerId === decoded.userId;
    if (!isOwner) {
      const currentUserPermission = await db.query.pagePermissions.findFirst({
        where: and(
          eq(pagePermissions.pageId, pageId),
          eq(pagePermissions.userId, decoded.userId)
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
      decoded.userId
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting permission:', error as Error);
    return NextResponse.json({ error: 'Failed to delete permission' }, { status: 500 });
  }
}
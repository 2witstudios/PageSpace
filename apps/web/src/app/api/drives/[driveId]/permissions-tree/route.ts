import { NextResponse } from 'next/server';
import { db, eq, and } from '@pagespace/db';
import { drives, pages, pagePermissions, driveMembers } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

interface PageNode {
  id: string;
  title: string;
  type: string;
  position: number;
  children: PageNode[];
  currentPermissions?: {
    canView: boolean;
    canEdit: boolean;
    canShare: boolean;
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const targetUserId = searchParams.get('userId');

    // Check if user is drive owner or admin
    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    const isOwner = drive[0].ownerId === user.id;
    let isAdmin = false;

    if (!isOwner) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, user.id),
          eq(driveMembers.role, 'ADMIN')
        ))
        .limit(1);

      isAdmin = adminMembership.length > 0;
    }

    if (!isOwner && !isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can view permission tree' }, { status: 403 });
    }

    // Get all pages in the drive
    const allPages = await db.select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      position: pages.position,
      isTrashed: pages.isTrashed,
    })
    .from(pages)
    .where(and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false)
    ));

    // Get existing permissions if targetUserId is provided
    const existingPermissions = new Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>();
    if (targetUserId) {
      const permissions = await db.select()
        .from(pagePermissions)
        .where(eq(pagePermissions.userId, targetUserId));
      
      permissions.forEach(perm => {
        existingPermissions.set(perm.pageId, {
          canView: perm.canView,
          canEdit: perm.canEdit,
          canShare: perm.canShare,
        });
      });
    }

    // Build tree structure
    const buildTree = (parentId: string | null): PageNode[] => {
      const children = allPages
        .filter(p => p.parentId === parentId)
        .sort((a, b) => a.position - b.position)
        .map(page => ({
          id: page.id,
          title: page.title,
          type: page.type,
          position: page.position,
          children: buildTree(page.id),
          currentPermissions: existingPermissions.get(page.id) || {
            canView: false,
            canEdit: false,
            canShare: false,
          },
        }));
      
      return children;
    };

    const tree = buildTree(null);

    // Also return drive info
    const driveInfo = {
      id: drive[0].id,
      name: drive[0].name,
      slug: drive[0].slug,
      ownerId: drive[0].ownerId,
    };

    return NextResponse.json({
      drive: driveInfo,
      pages: tree,
      totalPages: allPages.length,
    });
  } catch (error) {
    loggers.api.error('Error fetching permission tree:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch permission tree' },
      { status: 500 }
    );
  }
}
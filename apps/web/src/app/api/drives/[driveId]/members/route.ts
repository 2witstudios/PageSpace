import { NextResponse } from 'next/server';
import { db, eq, and, sql } from '@pagespace/db';
import { driveMembers, drives, users, userProfiles } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { createAuditEvent, extractAuditContext } from '@pagespace/lib/audit';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    // Check if user has access to this drive
    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user is a member of the drive (owner, admin, or regular member)
    const isOwner = drive[0].ownerId === userId;

    let isAdmin = false;

    if (!isOwner) {
      const membership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, userId)
        ))
        .limit(1);

      if (membership.length === 0) {
        return NextResponse.json({ error: 'You must be a drive member to view members' }, { status: 403 });
      }

      isAdmin = membership[0].role === 'ADMIN';
    }

    // Get all members with their profiles and permission counts
    const members = await db.select({
      id: driveMembers.id,
      userId: driveMembers.userId,
      role: driveMembers.role,
      invitedBy: driveMembers.invitedBy,
      invitedAt: driveMembers.invitedAt,
      acceptedAt: driveMembers.acceptedAt,
      lastAccessedAt: driveMembers.lastAccessedAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
      },
      profile: {
        username: userProfiles.username,
        displayName: userProfiles.displayName,
        avatarUrl: userProfiles.avatarUrl,
      }
    })
    .from(driveMembers)
    .leftJoin(users, eq(driveMembers.userId, users.id))
    .leftJoin(userProfiles, eq(driveMembers.userId, userProfiles.userId))
    .where(eq(driveMembers.driveId, driveId));

    // Get permission counts for each member
    const memberData = await Promise.all(members.map(async (member) => {
      // Count permissions for this user in this drive's pages
      const { rows: permCounts } = await db.execute(sql`
        SELECT 
          COUNT(CASE WHEN pp."canView" = true THEN 1 END) as view_count,
          COUNT(CASE WHEN pp."canEdit" = true THEN 1 END) as edit_count,
          COUNT(CASE WHEN pp."canShare" = true THEN 1 END) as share_count
        FROM page_permissions pp
        JOIN pages p ON pp."pageId" = p.id
        WHERE pp."userId" = ${member.userId} AND p."driveId" = ${driveId}
      `);

      return {
        ...member,
        permissionCounts: {
          view: Number(permCounts[0]?.view_count || 0),
          edit: Number(permCounts[0]?.edit_count || 0),
          share: Number(permCounts[0]?.share_count || 0),
        }
      };
    }));

    return NextResponse.json({
      members: memberData,
      currentUserRole: isOwner ? 'OWNER' : (isAdmin ? 'ADMIN' : 'MEMBER')
    });
  } catch (error) {
    loggers.api.error('Error fetching drive members:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch members' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    const body = await request.json();
    const { userId: invitedUserId, role = 'MEMBER' } = body;

    // Check if user is drive owner or has share permissions
    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (drive[0].ownerId !== userId) {
      return NextResponse.json({ error: 'Only drive owner can add members' }, { status: 403 });
    }

    // Check if member already exists
    const existingMember = await db.select()
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, invitedUserId)
      ))
      .limit(1);

    if (existingMember.length > 0) {
      return NextResponse.json({ error: 'User is already a member' }, { status: 400 });
    }

    // Add member
    const newMember = await db.insert(driveMembers)
      .values({
        driveId,
        userId: invitedUserId,
        role,
        invitedBy: userId,
        acceptedAt: new Date(), // Auto-accept for now
      })
      .returning();

    // Audit trail: Log member addition (fire and forget)
    const auditContext = extractAuditContext(request, userId);
    createAuditEvent({
      actionType: 'DRIVE_MEMBER_ADD',
      entityType: 'DRIVE_MEMBER',
      entityId: driveId,
      userId,
      driveId,
      afterState: {
        memberId: newMember[0].id,
        userId: invitedUserId,
        role,
      },
      description: `Added member with ${role} role to drive`,
      reason: 'User added drive member',
      metadata: {
        targetUserId: invitedUserId,
        role,
      },
      ...auditContext,
    }).catch(error => {
      loggers.api.error('Failed to audit member addition:', error as Error);
    });

    return NextResponse.json({ member: newMember[0] });
  } catch (error) {
    loggers.api.error('Error adding drive member:', error as Error);
    return NextResponse.json(
      { error: 'Failed to add member' },
      { status: 500 }
    );
  }
}
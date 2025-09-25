import { NextResponse } from 'next/server';
import { db, eq, and, sql } from '@pagespace/db';
import { driveMembers, drives, users, userProfiles } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

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

    // Check if user has access to this drive
    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user is owner or member
    const membership = await db.select()
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, user.id)
      ))
      .limit(1);

    if (drive[0].ownerId !== user.id && membership.length === 0) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
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

    return NextResponse.json({ members: memberData });
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
    const { driveId } = await context.params;
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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

    if (drive[0].ownerId !== user.id) {
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
        invitedBy: user.id,
        acceptedAt: new Date(), // Auto-accept for now
      })
      .returning();

    return NextResponse.json({ member: newMember[0] });
  } catch (error) {
    loggers.api.error('Error adding drive member:', error as Error);
    return NextResponse.json(
      { error: 'Failed to add member' },
      { status: 500 }
    );
  }
}
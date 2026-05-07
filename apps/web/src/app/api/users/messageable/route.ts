import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, and, or, ne, isNotNull, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { driveMembers, userProfiles } from '@pagespace/db/schema/members';
import { drives } from '@pagespace/db/schema/core';
import { connections } from '@pagespace/db/schema/social';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

export type MessageableSource = 'connection' | 'drive';

export interface MessageableUser {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  source: MessageableSource;
  sharedDriveCount: number;
}

// GET /api/users/messageable - Users the current user can DM (accepted
// connections ∪ drive co-members), deduplicated. When a user appears in both,
// `source` is reported as 'connection'.
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'messageable_users',
      resourceId: 'self',
    });

    const ownedDrives = await db
      .select({ id: drives.id })
      .from(drives)
      .where(eq(drives.ownerId, userId));

    const memberDrives = await db
      .select({ driveId: driveMembers.driveId })
      .from(driveMembers)
      .where(
        and(
          eq(driveMembers.userId, userId),
          isNotNull(driveMembers.acceptedAt)
        )
      );

    const myDriveIds = Array.from(
      new Set<string>([
        ...ownedDrives.map((d) => d.id),
        ...memberDrives.map((m) => m.driveId),
      ])
    );

    const driveCountByUserId = new Map<string, number>();
    if (myDriveIds.length > 0) {
      const otherOwners = await db
        .select({ userId: drives.ownerId, driveId: drives.id })
        .from(drives)
        .where(and(inArray(drives.id, myDriveIds), ne(drives.ownerId, userId)));

      const otherMembers = await db
        .select({ userId: driveMembers.userId, driveId: driveMembers.driveId })
        .from(driveMembers)
        .where(
          and(
            inArray(driveMembers.driveId, myDriveIds),
            ne(driveMembers.userId, userId),
            isNotNull(driveMembers.acceptedAt)
          )
        );

      const seen = new Set<string>();
      const bump = (uid: string, driveId: string) => {
        const key = `${uid}:${driveId}`;
        if (seen.has(key)) return;
        seen.add(key);
        driveCountByUserId.set(uid, (driveCountByUserId.get(uid) ?? 0) + 1);
      };
      for (const o of otherOwners) bump(o.userId, o.driveId);
      for (const m of otherMembers) bump(m.userId, m.driveId);
    }

    const userConnections = await db
      .select({
        user1Id: connections.user1Id,
        user2Id: connections.user2Id,
      })
      .from(connections)
      .where(
        and(
          or(
            eq(connections.user1Id, userId),
            eq(connections.user2Id, userId)
          ),
          eq(connections.status, 'ACCEPTED')
        )
      );

    const connectionUserIds = new Set<string>();
    for (const c of userConnections) {
      const other = c.user1Id === userId ? c.user2Id : c.user1Id;
      if (other) connectionUserIds.add(other);
    }

    const allUserIds = Array.from(
      new Set<string>([
        ...connectionUserIds,
        ...driveCountByUserId.keys(),
      ])
    );

    if (allUserIds.length === 0) {
      return NextResponse.json({ users: [] });
    }

    const userRows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        username: userProfiles.username,
        displayName: userProfiles.displayName,
        bio: userProfiles.bio,
        avatarUrl: userProfiles.avatarUrl,
      })
      .from(users)
      .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
      .where(inArray(users.id, allUserIds));

    const messageable: MessageableUser[] = userRows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      username: u.username,
      displayName: u.displayName,
      bio: u.bio,
      avatarUrl: u.avatarUrl,
      source: connectionUserIds.has(u.id) ? 'connection' : 'drive',
      sharedDriveCount: driveCountByUserId.get(u.id) ?? 0,
    }));

    messageable.sort((a, b) => {
      const an = (a.displayName || a.name || '').toLowerCase();
      const bn = (b.displayName || b.name || '').toLowerCase();
      return an.localeCompare(bn);
    });

    return NextResponse.json({ users: messageable });
  } catch (error) {
    loggers.api.error('Error fetching messageable users:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch messageable users' },
      { status: 500 }
    );
  }
}

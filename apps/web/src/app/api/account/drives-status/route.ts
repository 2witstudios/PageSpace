import { db, eq, and, sql, drives, driveMembers, users } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Get all drives owned by the user
    const ownedDrives = await db.query.drives.findMany({
      where: eq(drives.ownerId, userId),
      columns: {
        id: true,
        name: true,
      },
    });

    if (ownedDrives.length === 0) {
      return Response.json({
        soloDrives: [],
        multiMemberDrives: [],
      });
    }

    const driveIds = ownedDrives.map(d => d.id);

    // Count members for each drive
    const memberCounts = await Promise.all(
      driveIds.map(async (driveId) => {
        const count = await db
          .select({ count: sql<number>`count(*)` })
          .from(driveMembers)
          .where(eq(driveMembers.driveId, driveId));

        return {
          driveId,
          memberCount: Number(count[0]?.count || 0),
        };
      })
    );

    // Categorize drives
    const soloDrives = [];
    const multiMemberDrives = [];

    for (const drive of ownedDrives) {
      const memberCountData = memberCounts.find(mc => mc.driveId === drive.id);
      const memberCount = memberCountData?.memberCount || 0;

      if (memberCount <= 1) {
        // Solo drive (only owner, or no members which shouldn't happen but handle gracefully)
        soloDrives.push({
          id: drive.id,
          name: drive.name,
          memberCount,
        });
      } else {
        // Multi-member drive - get admins for transfer option
        const admins = await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            role: driveMembers.role,
          })
          .from(driveMembers)
          .innerJoin(users, eq(driveMembers.userId, users.id))
          .where(
            and(
              eq(driveMembers.driveId, drive.id),
              eq(driveMembers.role, 'ADMIN')
            )
          );

        multiMemberDrives.push({
          id: drive.id,
          name: drive.name,
          memberCount,
          admins: admins.map(admin => ({
            id: admin.id,
            name: admin.name,
            email: admin.email,
          })),
        });
      }
    }

    return Response.json({
      soloDrives,
      multiMemberDrives,
    });
  } catch (error) {
    loggers.auth.error('Error fetching drives status:', error as Error);
    return Response.json({ error: 'Failed to fetch drives status' }, { status: 500 });
  }
}

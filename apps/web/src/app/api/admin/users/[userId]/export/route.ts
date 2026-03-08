import { withAdminAuth } from '@/lib/auth/auth';
import { collectAllUserData } from '@pagespace/lib/compliance/export/gdpr-export';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

type ExportRouteContext = { params: Promise<{ userId: string }> };

/**
 * GET /api/admin/users/[userId]/export
 *
 * Admin DSAR export endpoint — returns all user data as JSON.
 * Used for data subject access requests (GDPR Article 15/20).
 */
export const GET = withAdminAuth<ExportRouteContext>(
  async (adminUser, request, context) => {
    const { userId } = await context.params;

    try {
      const data = await collectAllUserData(
        db as Parameters<typeof collectAllUserData>[0],
        userId,
      );

      if (!data) {
        return Response.json({ error: 'User not found' }, { status: 404 });
      }

      loggers.api.info(`Admin DSAR export: admin=${adminUser.id} target=${userId}`);

      return Response.json(
        {
          ...data,
          exportedAt: new Date().toISOString(),
          exportedBy: adminUser.id,
        },
        {
          headers: { 'Cache-Control': 'no-store' },
        }
      );
    } catch (error) {
      loggers.api.error('Admin DSAR export error:', error as Error);
      return Response.json({ error: 'Failed to export user data' }, { status: 500 });
    }
  }
);

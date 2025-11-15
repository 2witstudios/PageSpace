import { NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/auth';
import { getAuditEvents } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

/**
 * GET /api/admin/audit/export
 * Export audit logs for compliance and administrative review
 *
 * Query parameters:
 * - format: Export format ('json' or 'csv', default: 'json')
 * - fromDate: Start date for export (ISO 8601)
 * - toDate: End date for export (ISO 8601)
 * - category: Filter by category (page, permission, ai, file, drive, auth)
 * - actionType: Filter by specific action type
 * - userId: Filter by user ID
 * - driveId: Filter by drive ID
 * - limit: Maximum number of records (default: 1000, max: 10000)
 */
export async function GET(request: Request) {
  try {
    // Verify admin authentication
    const adminUser = await verifyAdminAuth(request);
    if (!adminUser) {
      return Response.json(
        { error: 'Unauthorized: Admin access required' },
        { status: 403 }
      );
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format') || 'json';
    const fromDate = searchParams.get('fromDate') ? new Date(searchParams.get('fromDate')!) : undefined;
    const toDate = searchParams.get('toDate') ? new Date(searchParams.get('toDate')!) : undefined;
    const category = searchParams.get('category') || undefined;
    const actionType = searchParams.get('actionType') || undefined;
    const userId = searchParams.get('userId') || undefined;
    const driveId = searchParams.get('driveId') || undefined;
    const limit = Math.min(parseInt(searchParams.get('limit') || '1000'), 10000);

    // Build filters
    const filters: {
      category?: string;
      actionType?: string;
      userId?: string;
      driveId?: string;
      startDate?: Date;
      endDate?: Date;
    } = {};

    if (category) filters.category = category;
    if (actionType) filters.actionType = actionType;
    if (userId) filters.userId = userId;
    if (driveId) filters.driveId = driveId;
    if (fromDate) filters.startDate = fromDate;
    if (toDate) filters.endDate = toDate;

    // Fetch audit events
    const events = await getAuditEvents({
      ...filters,
      limit,
    });

    // Log admin audit export
    loggers.api.info('Admin audit export requested', {
      adminUserId: adminUser.id,
      adminEmail: adminUser.email,
      filters,
      recordCount: events.length,
      format,
    });

    // Format response based on requested format
    if (format === 'csv') {
      // Convert to CSV format
      const csvHeader = 'ID,Timestamp,Action,Entity Type,Entity ID,User ID,Drive ID,Description,Is AI Action\n';
      const csvRows = events.map(event =>
        `${event.id},${event.createdAt.toISOString()},${event.actionType},${event.entityType},${event.entityId},${event.userId || ''},${event.driveId || ''},${JSON.stringify(event.description || '')},${event.isAiAction}`
      ).join('\n');

      const csv = csvHeader + csvRows;

      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="audit-export-${new Date().toISOString().split('T')[0]}.csv"`,
        },
      });
    }

    // Default JSON format
    return NextResponse.json({
      exportedAt: new Date().toISOString(),
      exportedBy: {
        id: adminUser.id,
        email: adminUser.email,
      },
      filters: {
        category,
        actionType,
        userId,
        driveId,
        fromDate: fromDate?.toISOString(),
        toDate: toDate?.toISOString(),
      },
      recordCount: events.length,
      records: events.map(event => ({
        id: event.id,
        timestamp: event.createdAt,
        actionType: event.actionType,
        entityType: event.entityType,
        entityId: event.entityId,
        userId: event.userId,
        driveId: event.driveId,
        isAiAction: event.isAiAction,
        description: event.description,
        reason: event.reason,
        beforeState: event.beforeState,
        afterState: event.afterState,
        changes: event.changes,
        metadata: event.metadata,
        user: event.user ? {
          id: event.user.id,
          name: event.user.name,
          email: event.user.email,
        } : null,
      })),
    });
  } catch (error) {
    loggers.api.error('Error exporting audit logs:', error as Error);
    return NextResponse.json(
      { error: 'Failed to export audit logs' },
      { status: 500 }
    );
  }
}

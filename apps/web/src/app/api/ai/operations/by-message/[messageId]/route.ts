import { NextResponse } from 'next/server';
import { db, aiOperations, auditEvents, pages, eq } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

/**
 * GET /api/ai/operations/by-message/[messageId]
 * Get all AI operations associated with a specific message
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ messageId: string }> }
) {
  const { messageId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Find all AI operations for this message
    const operations = await db.query.aiOperations.findMany({
      where: eq(aiOperations.messageId, messageId),
      orderBy: (ops, { desc }) => [desc(ops.createdAt)],
    });

    // For each operation, find affected pages via audit events
    const operationsWithPages = await Promise.all(
      operations.map(async (operation) => {
        // Find audit events for this operation
        const events = await db.query.auditEvents.findMany({
          where: eq(auditEvents.aiOperationId, operation.id),
          with: {
            page: {
              columns: {
                id: true,
                title: true,
                type: true,
              },
            },
          },
        });

        // Extract unique affected pages
        const affectedPages = events
          .filter(event => event.page)
          .map(event => ({
            id: event.page!.id,
            title: event.page!.title,
            type: event.page!.type,
            actionType: event.actionType,
          }));

        return {
          id: operation.id,
          operationType: operation.operationType,
          status: operation.status,
          prompt: operation.prompt,
          affectedPages,
          createdAt: operation.createdAt,
          completedAt: operation.completedAt,
        };
      })
    );

    return NextResponse.json({
      messageId,
      operations: operationsWithPages,
    });
  } catch (error) {
    loggers.api.error('Error fetching AI operations by message:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch AI operations' },
      { status: 500 }
    );
  }
}

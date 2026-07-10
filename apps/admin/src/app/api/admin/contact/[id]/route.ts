import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { contactSubmissions } from '@pagespace/db/schema/contact';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { withAdminAuth } from '@/lib/auth/auth';

type RouteContext = { params: Promise<{ id: string }> };

export const PATCH = withAdminAuth<RouteContext>(async (_adminUser, request, context) => {
  try {
    const { id } = await context.params;
    const body = await request.json() as { resolved: boolean };

    const [updated] = await db
      .update(contactSubmissions)
      .set({ resolvedAt: body.resolved ? new Date() : null })
      .where(eq(contactSubmissions.id, id))
      .returning({ id: contactSubmissions.id, resolvedAt: contactSubmissions.resolvedAt });

    if (!updated) {
      return Response.json({ error: 'Submission not found' }, { status: 404 });
    }

    return Response.json({ id: updated.id, resolvedAt: updated.resolvedAt });
  } catch (error) {
    loggers.api.error('Error updating contact submission:', error as Error);
    return Response.json({ error: 'Failed to update submission' }, { status: 500 });
  }
});

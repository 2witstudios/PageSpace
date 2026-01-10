import { NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createPageServiceToken } from '@pagespace/lib';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import { canUserEditPage } from '@pagespace/lib/permissions';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function POST(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  // Verify authentication
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { pageId } = await context.params;
  
  try {
    const [page] = await db
      .select({ revision: pages.revision })
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);

    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    const canEdit = await canUserEditPage(userId, pageId);
    if (!canEdit) {
      return NextResponse.json({ error: 'Insufficient permissions to reprocess this page' }, { status: 403 });
    }

    // Reset status to pending with deterministic logging
    const actorInfo = await getActorInfo(userId);
    await applyPageMutation({
      pageId,
      operation: 'update',
      updates: {
        processingStatus: 'pending',
        processingError: null,
      },
      updatedFields: ['processingStatus', 'processingError'],
      expectedRevision: page.revision,
      context: {
        userId,
        actorEmail: actorInfo.actorEmail,
        actorDisplayName: actorInfo.actorDisplayName,
        metadata: { source: 'reprocess' },
      },
      source: 'system',
    });
    
    // Create service JWT token for processor authentication (validates page permissions)
    const { token: serviceToken } = await createPageServiceToken(
      userId,
      pageId,
      ['files:ingest'],
      '2m'
    );

    // Enqueue unified ingestion on processor
    const resp = await fetch(`${PROCESSOR_URL}/api/ingest/by-page/${pageId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceToken}`
      }
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'Processor enqueue failed');
    }
    const { jobId } = await resp.json();
    
    return NextResponse.json({
      success: true,
      jobId,
      message: 'File queued for reprocessing'
    });
    
  } catch (error) {
    console.error('Reprocess failed:', error);
    return NextResponse.json(
      { error: 'Failed to reprocess file' },
      { status: 500 }
    );
  }
}

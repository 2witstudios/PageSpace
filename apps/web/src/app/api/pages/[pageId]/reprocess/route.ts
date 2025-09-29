import { NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
import { verifyAuth } from '@/lib/auth';
import { createServiceToken } from '@pagespace/lib/auth-utils';

export async function POST(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  // Verify authentication
  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  const { pageId } = await context.params;
  
  try {
    // Reset status to pending
    await db.update(pages)
      .set({ 
        processingStatus: 'pending',
        processingError: null
      })
      .where(eq(pages.id, pageId));
    
    // Create service JWT token for processor authentication
    const serviceToken = await createServiceToken('web', ['files:ingest'], {
      userId: user.id,
      tenantId: pageId,
      expirationTime: '2m'
    });

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

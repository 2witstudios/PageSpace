import { NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
import { getProducerQueue } from '@pagespace/lib/job-queue';
import { verifyAuth } from '@/lib/auth';

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
    
    // Enqueue new job with high priority for reprocessing
    const jobQueue = await getProducerQueue();
    const jobId = await jobQueue.enqueueFileProcessing(pageId, 'high');
    
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
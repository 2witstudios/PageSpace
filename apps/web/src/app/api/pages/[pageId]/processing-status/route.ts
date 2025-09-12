import { NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
import { getProducerQueue } from '@pagespace/lib/job-queue';

export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params;
  
  try {
    // Get page status
    const [page] = await db
      .select({
        processingStatus: pages.processingStatus,
        processingError: pages.processingError,
        extractionMethod: pages.extractionMethod,
        extractionMetadata: pages.extractionMetadata,
        processedAt: pages.processedAt,
        content: pages.content
      })
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);
    
    if (!page) {
      return NextResponse.json(
        { error: 'Page not found' },
        { status: 404 }
      );
    }
    
    // Return final status if processing is done
    if (page.processingStatus !== 'pending' && page.processingStatus !== 'processing') {
      return NextResponse.json({
        status: page.processingStatus,
        error: page.processingError,
        extractionMethod: page.extractionMethod,
        metadata: page.extractionMetadata,
        processedAt: page.processedAt,
        hasContent: !!page.content && page.content.length > 0
      });
    }
    
    // For pending/processing, check queue
    const jobQueue = await getProducerQueue();
    const stats = await jobQueue.getQueueStats();
    
    return NextResponse.json({
      status: page.processingStatus,
      queuePosition: stats.created + stats.retry,
      activeJobs: stats.active,
      estimatedWaitTime: (stats.created + stats.retry) * 15, // seconds
      message: 'File is being processed. Please check back shortly.'
    });
    
  } catch (error) {
    console.error('Error fetching status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch status' },
      { status: 500 }
    );
  }
}
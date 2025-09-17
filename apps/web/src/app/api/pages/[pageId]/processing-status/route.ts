import { NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

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
    
    // For pending/processing, check processor queue status
    const statusResp = await fetch(`${PROCESSOR_URL}/api/queue/status`);
    type QueueBucket = { active?: number; pending?: number; completed?: number; failed?: number };
    type QueueStatusMap = Record<string, QueueBucket>;
    let queueInfo: QueueStatusMap = {};
    if (statusResp.ok) {
      const raw = await statusResp.json();
      // Best-effort shape guard
      if (raw && typeof raw === 'object') {
        queueInfo = raw as QueueStatusMap;
      }
    }
    const ingest = queueInfo['ingest-file'] || { pending: 0, active: 0 };
    const queuePosition = ingest.pending ?? 0;
    const activeJobs = ingest.active ?? 0;
    const estimatedWaitTime = queuePosition * 15; // rough estimate in seconds

    return NextResponse.json({
      status: page.processingStatus,
      queuePosition,
      activeJobs,
      estimatedWaitTime,
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

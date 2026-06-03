import { NextRequest, NextResponse } from 'next/server';
import { resolveChannelTarget } from '@/lib/upload/attachment-route-helpers';
import { handleComplete } from '@/lib/upload/attachment-route-handlers';
import { loggers } from '@pagespace/lib/logging/logger-config';

/** Finalize a direct-to-S3 channel attachment (verify bytes, create file + link). */
export async function POST(request: NextRequest, context: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await context.params;
  try {
    const resolved = await resolveChannelTarget(request, pageId);
    if (!resolved.ok) return resolved.response;
    return await handleComplete(request, resolved);
  } catch (error) {
    loggers.api.error('Channel attachment complete error', error as Error, { pageId });
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 });
  }
}

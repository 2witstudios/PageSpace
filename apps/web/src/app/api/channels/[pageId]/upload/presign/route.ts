import { NextRequest, NextResponse } from 'next/server';
import { resolveChannelTarget } from '@/lib/upload/attachment-route-helpers';
import { handlePresign } from '@/lib/upload/attachment-route-handlers';
import { loggers } from '@pagespace/lib/logging/logger-config';

/** Reserve a slot + presigned PUT URL for a direct-to-S3 channel attachment. */
export async function POST(request: NextRequest, context: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await context.params;
  try {
    const resolved = await resolveChannelTarget(request, pageId);
    if (!resolved.ok) return resolved.response;
    return await handlePresign(request, resolved);
  } catch (error) {
    loggers.api.error('Channel attachment presign error', error as Error, { pageId });
    return NextResponse.json({ error: 'Failed to presign upload' }, { status: 500 });
  }
}

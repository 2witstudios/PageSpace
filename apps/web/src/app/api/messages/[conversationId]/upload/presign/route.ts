import { NextRequest, NextResponse } from 'next/server';
import { resolveConversationTarget } from '@/lib/upload/attachment-route-helpers';
import { handlePresign } from '@/lib/upload/attachment-route-handlers';
import { loggers } from '@pagespace/lib/logging/logger-config';

/** Reserve a slot + presigned PUT URL for a direct-to-S3 DM attachment. */
export async function POST(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  try {
    const resolved = await resolveConversationTarget(request, conversationId);
    if (!resolved.ok) return resolved.response;
    return await handlePresign(request, resolved);
  } catch (error) {
    loggers.api.error('DM attachment presign error', error as Error, { conversationId });
    return NextResponse.json({ error: 'Failed to presign upload' }, { status: 500 });
  }
}

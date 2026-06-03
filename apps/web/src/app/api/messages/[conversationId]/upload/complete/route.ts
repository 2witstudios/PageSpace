import { NextRequest, NextResponse } from 'next/server';
import { resolveConversationTarget } from '@/lib/upload/attachment-route-helpers';
import { handleComplete } from '@/lib/upload/attachment-route-handlers';
import { loggers } from '@pagespace/lib/logging/logger-config';

/** Finalize a direct-to-S3 DM attachment (verify bytes, create file + link). */
export async function POST(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  try {
    const resolved = await resolveConversationTarget(request, conversationId);
    if (!resolved.ok) return resolved.response;
    return await handleComplete(request, resolved);
  } catch (error) {
    loggers.api.error('DM attachment complete error', error as Error, { conversationId });
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 });
  }
}

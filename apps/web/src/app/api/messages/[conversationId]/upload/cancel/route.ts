import { NextRequest, NextResponse } from 'next/server';
import { authenticateAttachmentRequest } from '@/lib/upload/attachment-route-helpers';
import { handleCancel } from '@/lib/upload/attachment-route-handlers';
import { loggers } from '@pagespace/lib/logging/logger-config';

/** Release a presign-reserved slot when a DM attachment PUT fails. */
export async function POST(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  try {
    const auth = await authenticateAttachmentRequest(request);
    if (!auth.ok) return auth.response;
    return await handleCancel(request, auth.ctx);
  } catch (error) {
    loggers.api.error('DM attachment cancel error', error as Error, { conversationId });
    return NextResponse.json({ error: 'Failed to cancel upload' }, { status: 500 });
  }
}

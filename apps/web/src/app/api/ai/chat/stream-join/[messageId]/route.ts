import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { streamMulticastRegistry } from '@/lib/ai/core/stream-multicast-registry';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ messageId: string }> },
) {
  const authResult = await authenticateRequestWithOptions(request, {
    allow: ['session'],
    requireCSRF: false,
  });
  if (isAuthError(authResult)) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      resourceType: 'ai_stream',
      resourceId: 'stream-join',
      details: { reason: 'auth_failed', method: 'GET' },
      riskScore: 0.4,
    });
    return authResult.error;
  }
  const { userId } = authResult;

  const { messageId } = await context.params;

  const meta = streamMulticastRegistry.getMeta(messageId);
  if (!meta) {
    return NextResponse.json({ error: 'Stream not found' }, { status: 404 });
  }

  const canView = await canUserViewPage(userId, meta.pageId);
  if (!canView) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      resourceType: 'ai_stream',
      resourceId: messageId,
      details: { reason: 'insufficient_permissions', pageId: meta.pageId },
      riskScore: 0.5,
    });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const encoder = new TextEncoder();
  // Chunks that arrive during subscribe's synchronous buffer replay, before the
  // ReadableStream controller exists, are collected here and flushed in start().
  const preBuffer: Uint8Array[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let streamClosed = false;

  const unsubscribe = streamMulticastRegistry.subscribe(
    messageId,
    (part) => {
      const chunk = encoder.encode(`data: ${JSON.stringify({ part })}\n\n`);
      if (streamController) {
        streamController.enqueue(chunk);
      } else {
        preBuffer.push(chunk);
      }
    },
    (aborted) => {
      const done = encoder.encode(`data: ${JSON.stringify({ done: true, aborted })}\n\n`);
      if (streamController) {
        streamController.enqueue(done);
        streamController.close();
      } else {
        preBuffer.push(done);
      }
      streamClosed = true;
    },
  );

  // finish() deletes entries before notifying subscribers, so subscribe() returns
  // null for both unknown and already-finished streams.
  if (unsubscribe === null) {
    return NextResponse.json({ error: 'Stream not found' }, { status: 404 });
  }

  auditRequest(request, {
    eventType: 'authz.access.granted',
    resourceType: 'ai_stream',
    resourceId: messageId,
    details: { pageId: meta.pageId },
    riskScore: 0,
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      for (const chunk of preBuffer) {
        controller.enqueue(chunk);
      }
      if (streamClosed) {
        controller.close();
        return;
      }
      if (request.signal.aborted) {
        streamClosed = true;
        unsubscribe();
        controller.close();
        return;
      }
      request.signal.addEventListener('abort', () => {
        if (streamClosed) return;
        streamClosed = true;
        unsubscribe();
        controller.close();
      }, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}

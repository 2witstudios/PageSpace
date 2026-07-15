import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { streamMulticastRegistry } from '@/lib/ai/core/stream-multicast-registry';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { parseGlobalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { canSubscribeToStream } from '@/lib/ai/core/stream-subscription-authz';

export const dynamic = 'force-dynamic';

// How often to re-verify view access on an open SSE connection. Bounds the window during
// which a revoked user can keep receiving an in-flight stream to a few seconds, without
// putting a permission check in the hot path of every streamed chunk.
const PERMISSION_RECHECK_INTERVAL_MS = 5000;

// This connection survives today only because tokens flow continuously — a silent gap (a
// long tool call, deep research, an MCP round-trip with no output for minutes) sends nothing
// at all, and an idle HTTP connection is exactly what an intermediary (a load balancer, a
// reverse proxy, a corporate network appliance) is entitled to reap. A `: ping` comment frame
// is valid SSE (the leading colon marks it a comment; EventSource and every SSE client ignore
// it) and resets every idle timer between here and the browser without touching application
// state — no part is buffered, no liveness column is touched, nothing for a rejoining client
// to account for. Comfortably inside the shortest idle timeouts seen in practice (most sit at
// 30-60s or higher).
const PING_INTERVAL_MS = 20 * 1000;

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

  const channelOwner = parseGlobalChannelId(meta.pageId);
  // Page access, then conversation access. A page channel carries every conversation on
  // the page and conversations are private by default, so page access alone would let
  // any member join — and receive the tokens of — another member's PRIVATE conversation.
  // You may join a stream you started, or one in an explicitly shared conversation.
  const hasPageAccess = channelOwner !== null
    ? channelOwner === userId
    : await canUserViewPage(userId, meta.pageId);

  if (!hasPageAccess) {
    // A genuine authorization violation: this user has no business on this page at all.
    auditRequest(request, {
      eventType: 'authz.access.denied',
      resourceType: 'ai_stream',
      resourceId: messageId,
      details: { reason: 'insufficient_permissions', pageId: meta.pageId },
      riskScore: 0.5,
    });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Page access is not conversation access. A page room holds every member, but
  // conversations are private by default — the same rule listConversations enforces
  // (`userId = you OR isShared`). A member asking for a co-member's private stream is
  // not an attacker; it is the ordinary consequence of a page-wide broadcast. So this
  // is a plain 404 — the stream genuinely does not exist *for them* — and NOT an
  // audited 403, which would write an authz-denial row per member per assistant message
  // and bury real signal. Clients already treat a failed join as benign.
  const canSubscribe = async (): Promise<boolean> => canSubscribeToStream({
    userId,
    streamOwnerId: meta.userId,
    conversationId: meta.conversationId,
  });

  if (!(await canSubscribe())) {
    return NextResponse.json({ error: 'Stream not found' }, { status: 404 });
  }

  // Re-checked periodically for the life of the stream (the revocation backstop below).
  // Both halves must hold: page access can be revoked, and a shared conversation can be
  // un-shared, mid-stream.
  const hasViewAccess = async (): Promise<boolean> => {
    const pageOk = channelOwner !== null
      ? channelOwner === userId
      : await canUserViewPage(userId, meta.pageId);
    if (!pageOk) return false;
    return canSubscribe();
  };

  const encoder = new TextEncoder();
  const encodeDoneFrame = (aborted: boolean): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify({ done: true, aborted })}\n\n`);
  // Chunks that arrive during subscribe's synchronous buffer replay, before the
  // ReadableStream controller exists, are collected here and flushed in start().
  const preBuffer: Uint8Array[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let streamClosed = false;
  // Self-rescheduled after each check resolves (see recheckAccess) rather than a
  // fixed-cadence interval, so a slow permission check can't stack overlapping ones.
  let recheckTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const clearRecheckTimeout = () => clearTimeout(recheckTimeoutId);
  let pingIntervalId: ReturnType<typeof setInterval> | undefined;
  const clearPingInterval = () => clearInterval(pingIntervalId);

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
      clearRecheckTimeout();
      clearPingInterval();
      const done = encodeDoneFrame(aborted);
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
        clearRecheckTimeout();
        clearPingInterval();
        unsubscribe();
        controller.close();
      }, { once: true });

      const closeStreamAsDenied = (reason: string) => {
        streamClosed = true;
        clearPingInterval();
        unsubscribe();
        auditRequest(request, {
          eventType: 'authz.access.denied',
          resourceType: 'ai_stream',
          resourceId: messageId,
          details: { reason, pageId: meta.pageId },
          riskScore: 0.5,
        });
        try {
          controller.enqueue(encodeDoneFrame(true));
          controller.close();
        } catch {
          // Controller may already be closed via a racing path (e.g. client abort
          // firing between the streamClosed check above and this enqueue) — the
          // stream is already torn down either way, nothing more to do.
        }
      };

      const recheckAccess = async () => {
        if (streamClosed) return;
        let stillAllowed: boolean;
        try {
          stillAllowed = await hasViewAccess();
        } catch {
          // Fail closed: a broken permission check must not silently disable the
          // revocation backstop for the rest of the stream's lifetime. Without this,
          // a transient DB error would leave the stream open with no future rechecks.
          if (!streamClosed) closeStreamAsDenied('permission_recheck_failed');
          return;
        }
        if (streamClosed) return;

        if (stillAllowed) {
          recheckTimeoutId = setTimeout(() => void recheckAccess(), PERMISSION_RECHECK_INTERVAL_MS);
          return;
        }

        closeStreamAsDenied('permission_revoked_mid_stream');
      };

      recheckTimeoutId = setTimeout(() => void recheckAccess(), PERMISSION_RECHECK_INTERVAL_MS);

      pingIntervalId = setInterval(() => {
        if (streamClosed) {
          clearPingInterval();
          return;
        }
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          // Controller already closed via a racing path (e.g. client abort firing between
          // a prior tick and this one) — nothing more to send, same as
          // closeStreamAsDenied's enqueue guard above.
          clearPingInterval();
        }
      }, PING_INTERVAL_MS);
      pingIntervalId.unref?.();
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

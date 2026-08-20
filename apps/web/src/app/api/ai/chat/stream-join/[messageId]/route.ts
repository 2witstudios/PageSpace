import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { parseGlobalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { canSubscribeToStream } from '@/lib/ai/core/stream-subscription-authz';
import { resolveStreamJoinContext } from '@/lib/ai/core/stream-join-context';
import { acquireRemoteChannel } from '@/lib/ai/core/remote-frame-follower';

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
      details: { reason: 'auth_failed', method: 'GET', authFailureReason: authResult.authFailureReason },
      riskScore: 0.4,
    });
    return authResult.error;
  }
  const { userId } = authResult;

  const { messageId } = await context.params;

  // WHAT THIS INSTANCE CAN SAY ABOUT THE STREAM — the registry if it owns it, otherwise the
  // one thing every instance shares, its `ai_stream_sessions` row.
  //
  // The registry lookup used to be right here, ahead of the authz block, and it had to be: the
  // authz inputs lived in the same in-memory entry as the frames. At N>1 that made an ordinary
  // cross-instance join indistinguishable from a nonexistent one — both 404. The context module
  // maps the row to EXACTLY the `StreamMeta` shape the registry produces, so everything below
  // this line is unchanged and there is no second authorization path to keep in step with the
  // first. See stream-join-context.ts.
  const joinContext = await resolveStreamJoinContext(messageId);
  if (joinContext.kind === 'missing') {
    return NextResponse.json({ error: 'Stream not found' }, { status: 404 });
  }
  const meta = joinContext.meta;

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

  // The channel this joiner watches. `fromSeq` is the client's cursor: it asks for everything
  // it has not already applied, and gets exactly that. This replaces the skipReplayCount
  // arithmetic, where the server replayed its whole buffer and the client was told how many
  // frames to discard — under-skipping duplicated visible text, over-skipping left a silent
  // permanent gap, and neither was detectable from either side.
  //
  // A REMOTE or TERMINAL context is served by a follower that tails the durable frame log and
  // presents it as an ordinary `StreamChannel` — so everything below this line (the SSE framing,
  // the ping, the recheck, the teardown, the overflow/resumeFromSeq semantics) is ONE code path
  // for both sources. Forking the route body here is what this deliberately does not do: it
  // would mean two copies of five behaviours, one of which nothing local exercises.
  //
  // `terminal` is followed too, not short-circuited. The frames are deleted on the terminal
  // write, so a terminal row is exactly the case where the follower's honest-answer logic is
  // needed: serve whatever the log still holds, then end — with `truncated` when the log was
  // already released, which tells the client to reload rather than trust a short reply.
  const remote = joinContext.kind === 'local' ? null : acquireRemoteChannel(messageId);
  const channel = joinContext.kind === 'local' ? joinContext.channel : remote!.channel;
  const joinSource = joinContext.kind === 'local' ? 'local' : joinContext.kind;
  // Dropped in EVERY exit below, not only the happy one — a follower reference leaked by an
  // early return keeps a poller alive for a reader that never arrived.
  const releaseRemote = () => remote?.release();

  const requestedFromSeq = Number(new URL(request.url).searchParams.get('fromSeq') ?? '0');
  const fromSeq = Number.isFinite(requestedFromSeq) && requestedFromSeq >= 0
    ? Math.floor(requestedFromSeq)
    : 0;

  // ONE teardown for both halves of this joiner's hold: the channel subscription, and — when
  // the channel is a follower's — this reader's reference to it. Splitting them was the obvious
  // shape and the wrong one: every path that unsubscribed would have had to remember the
  // release too, and the one that forgot would keep a poller running against Postgres for a
  // reader that had already gone.
  let unsubscribeChannel: (() => void) | null = null;
  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    unsubscribeChannel?.();
    releaseRemote();
  };

  const unsubscribe = channel.subscribe({
    fromSeq,
    onFrame: ({ seq, chunk }) => {
      const frame = encoder.encode(`data: ${JSON.stringify({ seq, chunk })}\n\n`);
      if (streamController) {
        streamController.enqueue(frame);
      } else {
        preBuffer.push(frame);
      }
    },
    onEnd: (end) => {
      clearRecheckTimeout();
      clearPingInterval();
      // An `overflow` end means the cursor names a frame the ring no longer holds. Say so with
      // the seq that IS available rather than quietly serving a later prefix — the client can
      // then reseed deliberately instead of rendering a gap it cannot see.
      //
      // A `truncated` end is the OTHER thing, and they must not be conflated: it says there is
      // no resume point at all — the durable log was released or holds a hole — so the only
      // correct answer is `reload`, which the client turns into a read of the durably-persisted
      // message. Sending a bare `done` there would leave a short reply on screen looking whole.
      const done = end.reason === 'overflow'
        ? encoder.encode(`data: ${JSON.stringify({ done: true, resumeFromSeq: end.resumeFromSeq })}\n\n`)
        : encoder.encode(`data: ${JSON.stringify(
          end.truncated === true
            ? { done: true, aborted: end.aborted, reload: true }
            : { done: true, aborted: end.aborted },
        )}\n\n`);
      if (streamController) {
        streamController.enqueue(done);
        streamController.close();
      } else {
        preBuffer.push(done);
      }
      streamClosed = true;
      detach();
    },
  });
  unsubscribeChannel = unsubscribe;

  // finish() deletes entries before notifying subscribers, so subscribe() returns
  // null for both unknown and already-finished streams.
  if (unsubscribe === null) {
    detach();
    return NextResponse.json({ error: 'Stream not found' }, { status: 404 });
  }

  // The success-path audit is synchronous up to its DB write (the async write is caught
  // inside `audit` itself), and it is the last statement that can fail while BOTH holds are
  // live — the subscription above and, for a followed stream, this reader's reference to
  // the follower. An error propagating from here would strand both until the follower's
  // eviction backstop, so release them first and let it fly.
  try {
    auditRequest(request, {
      eventType: 'authz.access.granted',
      resourceType: 'ai_stream',
      resourceId: messageId,
      details: { pageId: meta.pageId },
      riskScore: 0,
    });
  } catch (error) {
    detach();
    throw error;
  }

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
        detach();
        controller.close();
        return;
      }
      request.signal.addEventListener('abort', () => {
        if (streamClosed) return;
        streamClosed = true;
        clearRecheckTimeout();
        clearPingInterval();
        detach();
        controller.close();
      }, { once: true });

      const closeStreamAsDenied = (reason: string) => {
        streamClosed = true;
        clearPingInterval();
        detach();
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
      // WHERE THE FRAMES CAME FROM. An N=2 smoke test has no other way to PROVE it exercised
      // the follower rather than getting lucky with the load balancer, and in production the
      // remote share should sit near (N-1)/N — a free check that traffic is actually spread and
      // that cross-instance joins are being served rather than silently falling back to polling.
      'X-Stream-Join-Source': joinSource,
    },
  });
}

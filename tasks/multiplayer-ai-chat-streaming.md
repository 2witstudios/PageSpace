# Multiplayer AI Chat Streaming

Stream AI responses to all active viewers of a chat page, not just the requesting client.

## Tasks

### Task 1: StreamMulticastRegistry ✅ COMPLETED
**PR:** https://github.com/2witstudios/PageSpace/pull/1140

Pure in-process pub/sub registry at `apps/web/src/lib/ai/core/stream-multicast-registry.ts`.

- Buffers chunks and multicasts to all subscribers
- Late-join replay of full buffer
- `finish(messageId, aborted?)` notifies all via `onComplete`
- 10-minute auto-cleanup via `setTimeout`
- Exported singleton `streamMulticastRegistry` + class for testing
- 18 tests, all passing

#### Review fixes (post-merge):
- Given `register` is called twice for the same `messageId`, should clear the first timer so `onComplete` fires only once
- Given a subscriber's `onComplete` callback throws, should still delete the entry and notify remaining subscribers
- Given a subscriber's `onChunk` callback throws during `push`, should not interrupt fanout to remaining subscribers
- `StreamMeta` interface must be exported for downstream tasks to type `getMeta` results

### Task 2: Stream Join Endpoint ✅ COMPLETED
**PR:** https://github.com/2witstudios/PageSpace/pull/1142 (recovery of #1141)

SSE endpoint at `apps/web/src/app/api/ai/chat/stream-join/[messageId]/route.ts`.

- GET endpoint that subscribes to an in-progress stream via `StreamMulticastRegistry`
- Auth: session tokens via `authenticateRequestWithOptions`
- Permissions: `canUserViewPage` check against `meta.pageId`
- SSE format: `data: {"text":"..."}\n\n` per chunk, `data: {"done":true,"aborted":bool}\n\n` on complete
- Proxy-friendly headers: `X-Accel-Buffering: no`
- Client disconnect: abort signal → `unsubscribe()` + `controller.close()`
- Race safety: subscribe called before ReadableStream created; buffer replay flushed in `start()`
- Returns 401/403/404 before streaming begins
- Audit logging on auth/permission denials
- 17 tests, all passing

#### Review fixes:
- Given stream is aborted, should emit `{"done":true,"aborted":true}` done sentinel to subscribers
- Given unauthenticated request, should emit `authz.access.denied` audit event
- Given request from user without view permission, should emit `authz.access.denied` audit event

### Task 3: Stream Socket Events ✅ COMPLETED
**PR:** https://github.com/2witstudios/PageSpace/pull/1144

Wire `chat:stream_start` and `chat:stream_complete` socket broadcasts into the AI chat route alongside the multicast registry.

- Given a new AI stream, should register the messageId in the multicast registry before emitting `chat:stream_start`
- Given `chat:stream_start`, should include messageId, pageId, conversationId, and triggeredBy in the payload
- Given stream completion or abort, should flush the registry and emit `chat:stream_complete` with an aborted flag
- Given a broadcast or registry call that throws, should not interrupt the AI response stream
- Given a route error that skips `onFinish`, should still emit `chat:stream_complete` via a finally path

### Task 4: AI Stream Client State
**Status:** ✅ COMPLETED
**PR:** https://github.com/2witstudios/PageSpace/pull/1149

Implement a Zustand store and socket hook that tracks in-progress remote streams and accumulates ghost text.

- Given `chat:stream_start` from another user, should register a pending stream and open a stream-join fetch connection
- Given `chat:stream_start` from the local user, should mark the stream as local and skip the SSE join
- Given incoming SSE chunks for a non-local stream, should accumulate text in the store keyed by messageId
- Given `chat:stream_complete`, should remove the stream and call the completion callback
- Given page unmount, should abort all in-flight join connections and clear all page streams from the store
- Given `chat:stream_start` with a different pageId than the active page, should ignore the event (stale-room guard)
- Given `chat:stream_complete` with a different pageId than the active page, should ignore the event
- Given SSE done sentinel resolves and `chat:stream_complete` also fires, should call `onStreamComplete` exactly once
- Given the socket reconnects while the hook is mounted, should re-emit `join_channel` to rejoin the page room

### Task 6: Shared Conversation Init (review fixes)
**Status:** In progress
**PR:** https://github.com/2witstudios/PageSpace/pull/1152

Fix `initializeChat` so all openers of an AI chat page land in the same conversation.

#### Acceptance criteria
- Given an existing conversation, should load it on page load without creating a new one via POST
- Given no conversations exist, should NOT POST a new server-side conversation (avoids race between concurrent openers)
- Given no conversations exist, should use a page-scoped deterministic conversation ID so concurrent openers share the same ID before either sends a message
- Given the conversations list fetch fails (non-ok or throws), should fall back to the page-scoped deterministic ID
- Given loaded conversation messages, should apply the fetched messages to chat state (not empty array)
- Given user clicks New Chat, should call `createConversation` from `useConversations` (existing behavior unchanged)

### Task 5: Multiplayer Chat UI
**Status:** Pending

Thread `pendingStreamsContent` through `ChatLayout` → `ChatMessagesArea` and render indicators and ghost text in `AiChatView`.

- Given a remote pending stream, should render a spinner with "X is waiting for AI response…" text
- Given accumulated ghost text from a remote stream, should render it in a muted style below the indicator
- Given multiple concurrent remote streams, should render a separate indicator for each
- Given `chat:stream_complete` for a remote stream, should remove its indicator and trigger SWR revalidation
- Given only a local stream in progress, should render no remote indicators
- Given the remote stream store has not changed, should keep the AI chat view render stable without triggering repeated updates

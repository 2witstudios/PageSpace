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

### Task 2: Wire registry into AI stream route
**Status:** Pending

In the AI chat stream API route, call `register` before streaming, `push` on each chunk, `finish` on completion/abort.

### Task 3: Socket.IO multicast event
**Status:** Pending

When `push` is called on the registry, emit a Socket.IO event to all clients subscribed to the page room.

### Task 4: Client-side subscription
**Status:** Pending

Hook AI chat page into the Socket.IO multicast events so non-requesting viewers see chunks arrive in real time.

### Task 5: Late-join HTTP replay endpoint
**Status:** Pending

Expose a GET endpoint that streams buffered chunks to a client that loads the page mid-stream.

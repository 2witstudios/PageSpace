# AI Chat Streaming Persistence & Multiplayer Epic

**Status**: 📋 PLANNED  
**Goal**: Persist AI stream sessions to the DB and extend full multiplayer streaming support to global chat

## Overview

Users who refresh mid-stream, open a second tab, or switch to global chat lose all visibility into in-progress AI responses — there is no recovery path and no stop button after reconnect. The core gap is that stream state lives only in process memory and in-flight socket events, so any late join misses everything. This epic adds a `aiStreamSessions` DB table as the source of truth, introduces a stable per-tab identity (`tabId`) to correctly attribute streams, wires full multicast/socket infrastructure into global chat, and adds a bootstrap endpoint so any component can reconstruct active stream state on mount.

---

## DB schema — aiStreamSessions table

Add `packages/db/src/schema/ai-streams.ts` with a new `aiStreamSessions` pgTable to persist streaming session state across server restarts and enable multiplayer bootstrap.

**Requirements**:
- Given a new schema file is added, should export `aiStreamSessions` from `packages/db/src/schema.ts`
- Given `channelId` field, should accept pageId for page chats and `user:${userId}:global` for global chat
- Given `status` field, should only allow values: 'streaming', 'complete', or 'aborted'
- Given (channelId, status) index, should enable fast queries for active streams per channel
- Given schema change, should run `pnpm db:generate` to produce migration files (never hand-edit SQL)

---

## messageId as canonical abort key

Wire `messageId` as the primary abort key so clients can cancel a specific stream by message ID rather than opaque stream ID.

**Requirements**:
- Given `createStreamAbortController` is called with a `messageId`, should populate the messageId→streamId index
- Given `removeStream` is called, should clean up the messageId index entry
- Given `abortStreamByMessageId` is called, should look up streamId from index and abort it
- Given abort route receives `{ messageId }` instead of `{ streamId }`, should resolve and abort the correct stream
- Given client calls `abortActiveStreamByMessageId`, should POST `{ messageId }` to `/api/ai/abort`

---

## tabId — per-tab identity

Introduce a stable per-browser-tab identity so multiplayer stream events can be filtered by the originating tab rather than just user ID.

**Requirements**:
- Given `getTabId()` is called on the same tab after a page refresh, should return the same UUID
- Given `getTabId()` is called in two different browser tabs, should return different UUIDs
- Given `createStreamTrackingFetch` makes any AI request, should include `X-Tab-Id` header
- Given `AiStreamStartPayload.triggeredBy`, should include `tabId` field alongside `userId` and `displayName`

---

## Page AI chat route — DB writes + tabId + messageId abort key

Upgrade the page AI chat route to persist stream sessions to DB, thread tabId through the multicast registry, and register messageId as the abort key.

**Requirements**:
- Given a stream starts, should INSERT a row into `aiStreamSessions` with status 'streaming'
- Given stream completes normally, should UPDATE status to 'complete' and set `completedAt`
- Given stream is aborted, should UPDATE status to 'aborted' and set `completedAt`
- Given `X-Tab-Id` header is present, should pass `tabId` to multicast registry and socket broadcast
- Given `serverAssistantMessageId` exists, should pass it as `messageId` to `createStreamAbortController`
- Given `broadcastAiStreamStart` payload, should include `tabId` in `triggeredBy`

---

## Global chat route — add full streaming infrastructure

Bring the global chat route to feature parity with the page chat route: multicast registry, DB persistence, socket events, and abort key registration.

**Requirements**:
- Given global chat stream starts, should register with multicast registry using `user:${userId}:global` as channelId
- Given global chat stream starts, should INSERT into `aiStreamSessions` with `channelId = \`user:${userId}:global\``
- Given `text-delta` events, should push chunks to multicast registry
- Given stream completes, should emit `broadcastAiStreamComplete` to the `user:${userId}:global` socket room
- Given stream is aborted, should UPDATE `aiStreamSessions` status to 'aborted'
- Given `finishMulticast` guard, should prevent double-broadcast if called more than once

---

## streamMulticastRegistry — richer metadata

Expand the `register()` metadata type to carry the full context needed by downstream consumers.

**Requirements**:
- Given `register()` is called, should accept `displayName`, `conversationId`, and `tabId` in addition to existing fields
- Given `getMeta()` is called on a registered stream, should return the full metadata including new fields
- Given both page and global route call sites, should be updated to pass the extended metadata
- Given the `StreamMeta` interface, should be exported so downstream consumers can type-check against it

---

## Active streams endpoint

Create `GET /api/ai/chat/active-streams?channelId=X` so clients can bootstrap multiplayer state on mount.

**Requirements**:
- Given an unauthenticated request, should return 401
- Given a page channel and a user without view permission, should return 403
- Given a global channel where the userId does not match the session user, should return 403
- Given active streams exist within the 10-minute window, should return them with full triggeredBy metadata
- Given no active streams, should return `{ streams: [] }`
- Given streams older than 10 minutes with status 'streaming', should exclude them from results

---

## usePendingStreamsStore — add isOwn

Extend the pending streams store with an `isOwn` flag to distinguish the current tab's streams from remote ones.

**Requirements**:
- Given `addStream` is called with `isOwn: true`, should store the flag on the PendingStream entry
- Given `addStream` is called with `isOwn: false`, should store the flag as false
- Given `getOwnStreams(channelId)`, should return only streams where `isOwn === true` for that channel
- Given existing callers of `addStream`, should be updated to pass `isOwn` without breaking

---

## useChatStreamSocket — tabId filter + DB bootstrap

Fix own-stream detection to use tabId, support global channel IDs, and bootstrap from DB on mount.

**Requirements**:
- Given a stream from any source, `isOwn` must be `triggeredBy.tabId === getTabId()` — tabId persists through refresh via sessionStorage so the originating tab correctly reclaims its stream; a different window of the same user gets `isOwn: false` (sees indicator, cannot stop)
- Given `channelId` is a `user:${userId}:global` string, should pass it through to the active-streams endpoint correctly
- Given active streams exist in DB at mount time, should bootstrap the store before any socket events arrive
- Given a bootstrapped stream completes via SSE, should call the same completion handler as live socket events
- Given the component unmounts, should abort all bootstrapped SSE connections

---

## Stop button for reconnected own streams in AiChatView

Show a stop button and wire abort-by-messageId for streams the current tab initiated, even after reconnect.

**Requirements**:
- Given `isStreaming` is true from local useChat, should show the stop button (existing behavior preserved)
- Given an own stream exists in `usePendingStreamsStore` with `isOwn: true`, should show the stop button
- Given the stop button is clicked for a pending own stream, should call `abortActiveStreamByMessageId` with the stream's messageId
- Given no local or pending own streams are active, should not show the stop button
- Given both a local stream and a pending own stream exist simultaneously, should show only one stop button

---

## Global chat socket room — realtime server

Auto-join each authenticated user to their `user:${userId}:global` socket room for global chat stream routing.

**Requirements**:
- Given a user authenticates with the realtime server, should automatically join the `user:${user.id}:global` socket room
- Given the user is already authenticated (prior checks pass), should not require an additional permission check
- Given the join follows the existing auto-join pattern for other rooms, should be placed in the same block for consistency

---

## GlobalChatContext — stream socket listener + bootstrap

Wire global chat context to handle multiplayer stream events: DB bootstrap on mount, live socket listeners, and SSE cleanup on unmount.

**Requirements**:
- Given mount with active streams in DB, should bootstrap `usePendingStreamsStore` before any socket event arrives
- Given a bootstrapped stream where `triggeredBy.tabId === getTabId()` (own stream), should call `setIsStreaming(true)` and `setStopStreaming(() => abortActiveStreamByMessageId(messageId))` so the existing stop button in the global chat UI works without any UI changes
- Given the bootstrapped own stream completes via SSE, should call `setIsStreaming(false)`, `setStopStreaming(null)`, and `refreshConversation`
- Given `chat:stream_start` from the current tab, should skip it (tabId filter prevents duplicate handling)
- Given `chat:stream_start` for a different user's global channel, should skip it (pageId guard)
- Given `chat:stream_start` for the correct channel from another tab, should addStream and open SSE join
- Given `chat:stream_complete`, should abort the SSE connection, removeStream, and call refreshConversation
- Given component unmounts, should abort all active SSE connections and remove all socket listeners

---

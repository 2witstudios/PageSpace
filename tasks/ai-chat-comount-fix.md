# AI Chat Co-mount Fix Epic

**Status**: 📋 PLANNED
**Goal**: Fix message stealing and streaming conflicts when the same AI agent is open in both the middle panel and right sidebar simultaneously.

## Overview

Why: When a user views an AI agent page in the middle panel while also selecting the same agent in the sidebar, both surfaces load the same conversation and compete — the module-level `activeStreams` Map keyed by `conversationId` gets overwritten between surfaces (causing the wrong stream to be aborted), socket `chat:stream_complete` events arrive at both surfaces but each finds no pending stream entry for own-session sends and silently bails, leaving the non-sending surface with stale messages. The fix has three layers: isolate each surface's stream-abort key so stops can't steal, add `conversationId` to the `chat:stream_complete` payload so non-sending surfaces can detect a co-mounted completion and reload, and guard the bootstrap SSE-join path so two co-mounted instances don't double-consume the same in-flight stream.

---

## Stream Abort Collision Tests

Write failing tests demonstrating that two `createStreamTrackingFetch` instances with the same `chatId` overwrite each other's active stream entry.

**Requirements**:
- Given two surfaces call `setActiveStreamId` with the same `chatId`, should the second call overwrite the first streamId (demonstrating the collision)
- Given surface A sets streamId then surface B sets a different streamId for the same chatId, calling `abortActiveStream` from surface A's perspective should target surface B's streamId (demonstrating the theft)

---

## Namespace Sidebar Transport chatId

Change `SidebarChatTab` to pass `"sidebar:" + agentConversationId` to `useChatTransport` instead of `agentConversationId` directly.

**Requirements**:
- Given the sidebar transport uses `sidebar:${conversationId}` as chatId, should `activeStreams` entries for middle panel and sidebar use distinct keys when both view the same conversation
- Given middle panel streams while sidebar is open on the same conversation, should middle panel's Stop button abort only its own stream
- Given sidebar streams, should not overwrite the middle panel's active stream entry

---

## Commit: Stream abort isolation ✦

---

## Add conversationId to stream_complete payload

Add `conversationId` to `AiStreamCompletePayload` in `socket-utils.ts` and pass it through `broadcastAiStreamComplete` in `stream-lifecycle.ts`, updating existing tests to cover the field.

**Requirements**:
- Given `AiStreamCompletePayload`, should include an optional `conversationId` field
- Given `broadcastAiStreamComplete` is called from the stream lifecycle, should forward the `conversationId` that was already available in `StreamLifecycleParams`
- Given existing socket-utils tests, should verify `conversationId` is present in the broadcast payload

---

## Thread conversationId through fireComplete

Update `useChannelStreamSocket` so `handleStreamComplete` passes `payload.conversationId` to `fireComplete`, and the `onStreamComplete` callback signature becomes `(messageId: string, conversationId?: string)`.

**Requirements**:
- Given `chat:stream_complete` fires with a `conversationId`, should the `onStreamComplete` callback receive it as second argument
- Given the bootstrap SSE path finishes consuming a stream, should also pass the stream's `conversationId` to `onStreamComplete`

---

## Co-mount reload helper tests

Create `apps/web/src/lib/ai/streams/__tests__/shouldReloadOnComountComplete.test.ts` and the corresponding pure helper at `apps/web/src/lib/ai/streams/shouldReloadOnComountComplete.ts`.

**Requirements**:
- Given no pending stream in the store and completedConvId matches the active conversation, should return `true` (reload needed)
- Given a pending stream exists with parts and matching conversation, should return `false` (stream handled by synthesize path)
- Given completedConvId does not match the active conversation, should return `false`
- Given completedConvId is undefined, should return `false`

---

## Wire co-mount reload into multiplayer hook and AiChatView

Use `shouldReloadOnComountComplete` in `useAgentChannelMultiplayer`'s `onStreamComplete` to call `loadConversation` when the helper returns true, and apply the same fallback in `AiChatView`'s `onStreamComplete` handler.

**Requirements**:
- Given middle panel sends while sidebar is open on the same conversation, should sidebar auto-reload messages from DB after stream completes
- Given sidebar sends while middle panel is open on the same conversation, should middle panel auto-reload messages from DB after stream completes
- Given a remote user (different browser session) streams, should still synthesize the message locally from the pending store (existing behavior unchanged)

---

## Commit: Cross-surface message sync ✦

---

## Bootstrap de-dup guard tests

Add tests to `apps/web/src/hooks/__tests__/useChannelStreamSocket.test.ts` (or create the file) that demonstrate the double-consume problem when two instances bootstrap the same in-flight stream.

**Requirements**:
- Given two `useChannelStreamSocket` instances bootstrap the same `messageId`, should `appendPart` be called only once per chunk (not doubled)
- Given the first consumer's surface unmounts, should release the bootstrap claim so the second surface can consume the stream

---

## Implement bootstrap de-dup guard

Add a module-level `activeBootstrapConsumers: Set<string>` in `useChannelStreamSocket.ts`; gate `startConsume` on claiming the set; release on SSE resolve/reject and on the cleanup teardown for aborted controllers.

**Requirements**:
- Given two co-mounted surfaces bootstrap the same stream, should only one surface call `startConsume`
- Given the consuming surface unmounts mid-stream, should delete the messageId from the registry so another surface can take over
- Given a surface unmounts and remounts after the stream ends, should allow fresh consumption of a new bootstrap

---

## Commit: Bootstrap de-dup guard ✦

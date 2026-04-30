# DM File Attachments Epic

**Status**: 📋 PLANNED
**Goal**: Let users send each other files in DM conversations at feature parity with channels.

## Overview

Channels already support file attachments end-to-end (schema, upload, renderer, realtime). DMs cannot — `directMessages` has only `content: text`, and `files.driveId` is `NOT NULL`, but `dmConversations` lives outside any drive. The processor and storage layer are already content-hash addressed and the storage quota is already user-scoped, so the obstacle is a schema-level scoping rule plus the wiring on top of it. This epic extends `files` with a `fileConversations` join table (mirroring `filePages`) and makes `driveId` nullable, then lands four DRY refactors before any DM-specific code so channels and DMs share a single upload core, service-token issuer, processor binding, composer hook, and renderer component.

---

## Centralize AttachmentMeta type

Define `AttachmentMeta` once in `packages/db/src/schema/storage.ts` (next to `files`; canonical owner), re-export it from `packages/lib/src/types.ts` for non-db consumers, and import on both `channelMessages.attachmentMeta` and `directMessages.attachmentMeta` JSONB columns. Keeping the canonical type in db avoids the `db → lib → db` cycle.

**Requirements**:
- Given the existing `channelMessages` table, schema and tests should still typecheck against the imported type with zero behavior change.

---

## Extract MessageAttachment shared component

Pull the attachment block from `ChannelView.tsx:537-580` into `apps/web/src/components/shared/MessageAttachment.tsx`, consumed by both channel and DM message renderers.

**Requirements**:
- Given a message with `fileId` + `attachmentMeta`, should render image preview or download card pixel-identically to today's ChannelView.
- Given the existing channel attachment tests, should still pass without modification.

---

## Extract useAttachmentUpload hook

Pull drag-drop / paste / file-picker / optimistic-state / error-handling out of `ChannelInput.tsx` into `apps/web/src/hooks/useAttachmentUpload.ts`, parameterized by upload URL.

**Requirements**:
- Given an in-flight upload, the hook should register state with `useEditingStore` so SWR cannot clobber the pending upload.
- Given the channel composer after refactor, should behave identically to today across drag, paste, picker, error, and optimistic-state flows.

---

## Polymorphic attachment-upload core

Introduce `AttachmentTarget = { type: 'page'; pageId; driveId } | { type: 'conversation'; conversationId }`, a single `createAttachmentUploadServiceToken({ userId, target })`, a single `processAttachmentUpload({ request, target })` in `packages/lib/src/services/attachment-upload.ts`, and a polymorphic dispatch in `apps/processor/src/api/upload.ts:124`. The channel upload route is rewritten as a thin wrapper.

**Requirements**:
- Given a page target, channel upload should behave identically to today end-to-end.
- Given a conversation target with a non-participant user, the service-token mint should fail before reaching the processor.
- Given the polymorphic processor handler, an unknown target type should reject with 400 rather than crashing or defaulting.
- Given a conversation-target upload, the processor should write the file with `driveId = NULL` and a `fileConversations` linkage instead of `filePages`.

---

## Schema: nullable driveId, fileConversations, DM message attachment fields

Modify `packages/db/src/schema/storage.ts` and `packages/db/src/schema/social.ts`; generate via `pnpm db:generate`.

**Requirements**:
- Given a file uploaded with no drive context, should persist with `driveId = NULL` and a row in `fileConversations`.
- Given an existing channel-attached file, the migration should leave it unchanged with `driveId` populated and no `fileConversations` row.
- Given a deleted DM conversation, `fileConversations` rows should cascade-delete while `files` rows should NOT — orphan GC handles them.
- Given a deleted DM message, the `directMessages.fileId` reference should `SET NULL` so other messages and the conversation linkage survive.

---

## Permission helper: conversation-linked file access

Update `canUserAccessFile()` to accept a nullable `driveId` and add a second linkage branch for `fileConversations`. NO new file-serving routes — `/api/files/[id]/{view,download}` generalize once the helper updates.

**Requirements**:
- Given Alice and Bob in a DM with an attached file, both should access it via the existing `/api/files/[id]/...` routes.
- Given Carol who is not a participant, should be denied access.
- Given a file linked to both a page and a conversation, should grant access if either path qualifies, without leaking page access to non-page-viewers or conversation membership to non-participants.
- Given a file with no linkages and `driveId === null`, should be denied (no fall-through to "anyone can see it").

---

## DM upload route

Create `apps/web/src/app/api/messages/[conversationId]/upload/route.ts` as a thin wrapper that builds a conversation `AttachmentTarget` and delegates to `processAttachmentUpload`.

**Requirements**:
- Given a non-participant uploads to a conversation, should return 403.
- Given an unverified email, should return 403 with `requiresEmailVerification: true` matching DM POST behavior.
- Given storage quota exceeded, should return 413 at parity with channel upload.
- Given a successful upload, the response shape should match channel upload exactly so the shared `useAttachmentUpload` hook needs no per-target branching.

---

## DM POST accepts file and broadcast carries it

Update `apps/web/src/app/api/messages/[conversationId]/route.ts` POST to accept optional `fileId` + `attachmentMeta`, validate ownership and conversation linkage, persist on `directMessages`, and include both fields in the existing `new_dm_message` realtime payload and inbox event.

**Requirements**:
- Given a DM with only a file (empty `content`), should be accepted and rendered without an empty-string artifact.
- Given a `fileId` for a file the sender did not upload, should return 403.
- Given a `fileId` for a file not linked to this conversation, should return 403 (prevents cross-DM file smuggling).
- Given a delivered DM with a file, the receiver's client should receive the full payload over Socket.IO without an extra fetch.
- Given a DM whose only payload is an attachment, `dmConversations.lastMessagePreview` should render a synthetic preview (`[image: name.png]` or `[file: name.pdf]`) so inbox lists are meaningful.

---

## DM UI composer and renderer

Update `apps/web/src/components/messages/ChatInput.tsx` to consume `useAttachmentUpload` against the DM upload route, and render attachments via the shared `MessageAttachment` component.

**Requirements**:
- Given a user pastes, drops, or picks a file in the DM composer, should upload optimistically and send on submit with the same UX as channels.
- Given a received DM with an image, should render a clickable thumbnail; with a non-image, should render the download card — pixel-identical to channels.

---

## Lifecycle and orphan GC

Soft-delete a DM message via `directMessages.isActive = false`. Find the existing orphan-file GC and extend its predicate; do NOT introduce a new GC.

**Requirements**:
- Given a deleted conversation whose attached files are not linked elsewhere, the GC should reclaim the rows and blobs and decrement the uploader's `users.storageUsedBytes` by exactly `sizeBytes` per file.
- Given a deleted conversation containing a file also linked to a still-live page or another conversation, neither the `files` row nor the blob should be reclaimed.
- Given a soft-deleted DM message, the file and its `fileConversations` row should remain so other messages and inbox previews are not broken.

---

## Tests

TDD per `references/tdd.md`; colocate with source.

**Requirements**:
- Given the new `canUserAccessFile` branch, should have tests for participant-grant, non-participant-deny, dual-linked isolation, and unlinked-null-drive deny.
- Given the polymorphic service-token issuer, should have tests for page-branch parity, conversation-branch participant validation, and unknown-type rejection.
- Given `processAttachmentUpload`, should have tests for happy path on both target types, quota gate, and email-verification gate.
- Given DM POST with `fileId`, should have tests for happy path, cross-conversation rejection, and non-owner rejection.
- Given the orphan GC, should have tests for both reclaim and no-reclaim paths.

---

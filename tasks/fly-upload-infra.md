# Fly.io Upload Infrastructure Epic

**Status**: 📋 PLANNED
**Goal**: Migrate upload infrastructure from local VPS filesystem to Tigris S3, enable video uploads in channels/DMs, and add batch upload support.

## Overview

Why: The current upload system is designed for a single VPS with persistent Docker volumes and process-memory-based concurrency limits. Moving to Fly.io means multiple machines with no shared local disk — local filesystem storage breaks entirely in this model. This epic replaces local storage with Tigris (Fly.io's native S3-compatible object store), switches file delivery to presigned URLs (removing read traffic from the processor), strips out the VPS-specific memory monitor, raises per-file limits to support video sharing in channels and DMs (like Slack/Google Drive), and adds batch upload so users can drop multiple files at once.

---

## S3 Storage Backend

Replace `ContentStore`'s local `fs` operations with Tigris S3 SDK calls in the processor service.

**Requirements**:
- Given a file upload, should write the original to S3 at key `files/{contentHash}/original` using `@aws-sdk/lib-storage` Upload (auto-multipart for files >5MB)
- Given a cached variant (thumbnail, OCR output), should write to S3 at key `cache/{contentHash}/{preset}`
- Given a deduplication check, should use `HeadObject` on the S3 key and skip upload if the object already exists
- Given temp file written by multer to `/tmp`, should stream it to S3 then delete the local copy
- Given processor startup, should read `TIGRIS_BUCKET`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` from env
- Given `FILE_STORAGE_PATH` and `CACHE_PATH` env vars, should no longer be required (remove from server.ts and Dockerfile)

---

## Presigned URL Delivery

Replace processor-proxied file reads with short-lived presigned GET redirects from Tigris.

**Requirements**:
- Given a request to `/api/files/[id]/view`, should verify user has access then return a `302` redirect to a presigned Tigris GET URL
- Given a request to `/api/files/[id]/download`, should add `response-content-disposition=attachment` to the presigned URL before redirecting
- Given an image or video file, should use a 3600s TTL presigned URL
- Given a document (PDF, office file), should use a 900s TTL presigned URL
- Given the Tigris bucket, should remain private — all access goes through web API auth gates, not public bucket policy
- Given a new `packages/lib/src/services/presigned-url.ts`, should export `generatePresignedUrl(contentHash, preset?, ttlSeconds)` reusable by both web and processor

---

## Remove VPS Memory Constraints

Strip out the process-memory-aware concurrency controls that have no meaning in a multi-machine deployment.

**Requirements**:
- Given `memory-monitor.ts`, should replace implementation with a stub that always returns `{ warningLevel: 'normal', canAcceptUpload: true }` (keeps interface intact so call sites compile)
- Given the upload route in `apps/web/src/app/api/upload/route.ts`, should remove the `checkMemoryMiddleware` gate
- Given `upload-semaphore.ts`, should remove the 30-second memory-polling interval and dynamic limit adjustment; keep per-user tier slot tracking only
- Given `docker-compose.yml`, should remove `file_storage` and `cache_storage` volume mounts and `mem_limit` caps from processor and web services

---

## Raise Upload Limits + Video Support

Raise per-file size limits to support video and add video processing in the ingest worker.

**Requirements**:
- Given `STORAGE_TIERS` in `storage-limits.ts`, should update maxFileSize: free=50MB, pro=250MB, founder=500MB, business=1GB
- Given multer configuration in `apps/processor/src/api/upload.ts`, should raise `limits.fileSize` to use `getMaxFileSizeBytes()` instead of the hardcoded 50MB cap
- Given a video MIME type (`video/mp4`, `video/webm`, `video/quicktime`, `video/x-msvideo`, `video/x-matroska`), should be accepted by the processor upload handler
- Given the processor Dockerfile, should install `ffmpeg` via apt-get
- Given a video file completing ingest, should extract the first frame as a `thumbnail.webp` via ffmpeg and upload it to S3 at `cache/{hash}/thumbnail.webp`
- Given a video file completing ingest, should extract duration, width, and height via `ffprobe` and write `{ duration, width, height, thumbnailKey }` to the message's `attachmentMeta` JSONB field

---

## Preserve Quota Counter

Ensure `updateStorageUsage` is called correctly on all upload paths after the Tigris migration so the running `users.storageUsedBytes` counter stays accurate (metered billing will eventually replace tier quotas, but the counter must stay live in the meantime).

**Requirements**:
- Given a file upload via the main upload route, should call `updateStorageUsage` after the S3 write succeeds
- Given a file upload via `processAttachmentUpload` (channels and DMs), should call `updateStorageUsage` after the S3 write succeeds
- Given a file deletion, should call `updateStorageUsage` with a negative delta

---

## Batch Upload in Channels/DMs

Allow users to select and send multiple files at once in channel and DM message composers.

**Requirements**:
- Given a channel upload request with multiple files in `formData.getAll('file')`, should call `processAttachmentUpload` per file and return an array of upload results
- Given a DM upload request with multiple files, should apply the same batch pattern as channels
- Given `attachment-upload.ts`, should add `processAttachmentUploads(files[], target)` that runs uploads serially and emits a realtime event after each file completes
- Given the message composer UI, should change the file input from `multiple={false}` to `multiple` and render one attachment bubble per file in the pending message

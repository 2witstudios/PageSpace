# Performance Hardening Review

## What Was Fixed

- **Permission cache actually works now.** The batch lookup now asks the database for "any of these page IDs" instead of the impossible "all IDs must match at once", so the first request fills the cache and everything afterwards is fast.
- **Permission changes take effect right away.** Any time someone is granted or revoked access we clear the cached copy for that user/drive, so no one keeps stale access for a minute.
- **Upload limiter honors the real limit.** Dynamic scaling now tracks "how many uploads are allowed" separately from "how many are running". When the system tightens the limit, the counter follows suit and new uploads pause until slots free up.
- **Uploads stay off the heap.** Hashing/deduplication now streams from disk, uses a quick existence check, and avoids loading the whole file into memory. Temp files still get cleaned up, but the processor no longer double-buffers large uploads.
- **Processor logging is structured.** Upload endpoints now emit compact JSON logs (info/warn/error) with file metadata, giving processors visibility without the noisy raw `console.log` lines.

## Operational Notes

- Redis-based permission cache can be warmed via `/api/permissions/batch`; it now reflects DB state immediately after any modification.
- Upload throttling respects `UPLOAD_BASE_PERMITS`/`UPLOAD_MAX_PERMITS` even after memory spikes; check `uploadSemaphore.getStatus()` to see the live limit and active slot count.
- Processor upload logs now show as JSON lines that include the service name (`processor`), helping tail/debug sessions stay consistent with the rest of the stack.

## Suggested Follow Ups

- Consider wiring the permission invalidation helpers into any other codepaths that edit permissions outside `packages/lib/permissions.ts` (if they exist).
- Schedule a load test that exercises uploads during low-memory conditions to validate the new semaphore behaviour end-to-end.

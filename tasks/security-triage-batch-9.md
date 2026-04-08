# Security Alert Triage — Batch 9: Missing Rate Limiting in Processor Upload Tests

## Summary

CodeQL's `js/missing-rate-limiting` rule flagged 13 alerts in the upload test file's mock Express apps. All are **false positives (S3)** — the production handler already applies rate limiting, and the test intentionally mocks it out to isolate route handler logic.

## Alerts #105–#117 — js/missing-rate-limiting (CWE-770)

**File**: `apps/processor/src/api/__tests__/upload.test.ts`

| Alert | Line | Rating | Action |
|-------|------|--------|--------|
| #105 | 564 | S3 — False Positive | Dismiss |
| #106 | 595 | S3 — False Positive | Dismiss |
| #107 | 620 | S3 — False Positive | Dismiss |
| #108 | 640 | S3 — False Positive | Dismiss |
| #109 | 664 | S3 — False Positive | Dismiss |
| #110 | 686 | S3 — False Positive | Dismiss |
| #111 | 708 | S3 — False Positive | Dismiss |
| #112 | 731 | S3 — False Positive | Dismiss |
| #113 | 779 | S3 — False Positive | Dismiss |
| #114 | 803 | S3 — False Positive | Dismiss |
| #115 | 827 | S3 — False Positive | Dismiss |
| #116 | 849 | S3 — False Positive | Dismiss |
| #117 | 894 | S3 — False Positive | Dismiss |

**Shared rationale**: Test file exercising upload route handler logic with intentionally mocked rate-limit middleware (lines 80–82 mock `rateLimitUpload` to always call `next()`). Production handler at `apps/processor/src/api/upload.ts:96` already applies `rateLimitUpload` — a token bucket rate limiter (per-user/IP keyed, configurable via `PROCESSOR_UPLOAD_RATE_LIMIT` env var), added in commit `766dfcb` (#566). No production exposure. Adding rate limiting to test mocks would defeat the purpose of unit testing.

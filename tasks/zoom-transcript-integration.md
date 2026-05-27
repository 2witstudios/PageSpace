# Zoom Transcript Integration Epic

**Status**: 📋 PLANNED
**Goal**: Auto-save Zoom meeting transcripts as Document pages in a user-configured PageSpace drive whenever a recording finishes.

## Overview

Teams lose meeting context because Zoom transcripts live in Zoom's portal and never make it into the shared workspace. This integration closes that gap: when a Zoom recording transcript is ready, a webhook fires, PageSpace downloads the VTT file, runs an AI summary and action-item extraction, and creates a structured Document page in the drive and folder the user configured — no manual steps. Follows the Google Calendar integration pattern (dedicated DB table, dedicated route set, same OAuth state/encryption).

---

## DB Schema

Create `packages/db/src/schema/zoom.ts` with the `zoom_connections` table and export it from the schema index.

**Requirements**:
- Given a new file `packages/db/src/schema/zoom.ts`, should define `zoomConnectionStatus` pgEnum and `zoomConnections` pgTable with fields: `id`, `userId` (unique FK → users, cascade delete), encrypted `accessToken`, optional `refreshToken`, `tokenExpiresAt`, `status`, `zoomUserId`, `zoomAccountId`, `zoomEmail`, `targetDriveId` (FK → drives, set null), `targetFolderId` (soft ref, no FK), `includeAiSummary` (default true), `includeActionItems` (default true), `includeTranscript` (default true), `createdAt`, `updatedAt`
- Given the schema file exists, should be exported from `packages/db/src/schema/index.ts`
- Given schema changes, should run `bun run db:generate` to produce a migration and `bun run db:migrate` to apply it

---

## Webhook Verification Utilities

Create `apps/web/src/lib/integrations/zoom/verify-webhook.ts` with signature verification and URL challenge handler.

**Requirements**:
- Given `x-zm-signature`, `x-zm-request-timestamp`, raw body string, and `ZOOM_WEBHOOK_SECRET_TOKEN`, `verifyZoomWebhookSignature` should compute `HMAC-SHA256(secret, "v0:{timestamp}:{body}")`, prepend `"v0="`, and return true only when it matches the signature header using `secureCompare`
- Given a timestamp older than 5 minutes, should return false to reject replayed requests
- Given a `plainToken` string and the secret, `handleUrlValidationChallenge` should return `{ plainToken, encryptedToken }` where `encryptedToken` is `HMAC-SHA256(secret, plainToken)` as hex
- Given unit tests in `__tests__/verify-webhook.test.ts`, should cover valid sig, invalid sig, stale timestamp, and correct challenge output

---

## VTT Transcript Parser

Create `apps/web/src/lib/integrations/zoom/parse-vtt.ts` to convert Zoom's VTT format into structured data and HTML.

**Requirements**:
- Given a VTT string, `parseVtt` should return `VttSegment[]` where each segment has `speaker`, `text`, and `startTime`
- Given segments with the same consecutive speaker, `vttToHtml` should group them into a single `<p>` block formatted as `<p><strong>Speaker</strong><br>text</p>`
- Given a segment with no speaker label, should fall back to `"Unknown"` rather than crashing
- Given unit tests in `__tests__/parse-vtt.test.ts`, should cover multi-speaker, no-label, and empty-input cases

---

## Document Builder

Create `apps/web/src/lib/integrations/zoom/build-document.ts` to assemble the final HTML document.

**Requirements**:
- Given meeting metadata, `buildDocumentHtml` should always output a metadata block (date, duration, host) regardless of other options
- Given a non-empty `summary` string, should include an `<h2>Summary</h2>` section above the transcript
- Given a non-empty `actionItems` array, should include an `<h2>Action Items</h2><ul>` section; each item should append `(assignee)` when an assignee is present
- Given `transcriptHtml` is non-empty, should include an `<h2>Transcript</h2>` section
- Given unit tests in `__tests__/build-document.test.ts`, should cover all sections on, summary+actions only, and metadata-only

---

## AI Utilities

Create `apps/web/src/lib/integrations/zoom/generate-summary.ts` and `extract-action-items.ts`.

**Requirements**:
- Given a `userId` and transcript plain text, `generateTranscriptSummary` should call the workspace AI provider with a prompt to summarize in 3–5 bullet points focused on decisions and outcomes
- Given a `userId` and transcript plain text, `extractActionItems` should call the workspace AI provider and return `ActionItem[]` parsed from a JSON response containing `{ text, assignee? }` objects
- Given any AI provider error or timeout, both functions should return an empty value (`''` or `[]`) without throwing, so a failed AI call never blocks transcript storage

---

## OAuth Routes

Create `connect`, `callback`, `status`, and `disconnect` routes under `apps/web/src/app/api/integrations/zoom/`.

**Requirements**:
- Given an authenticated user POSTing to `connect`, should build a HMAC-signed state (reusing `OAUTH_STATE_SECRET`), construct the Zoom OAuth authorization URL with scopes `recording:read:admin user:read`, and return `{ url }`
- Given Zoom redirecting to `callback` with `code` and `state`, should verify the HMAC state signature and expiry, exchange the code for tokens using `ZOOM_OAUTH_CLIENT_ID`/`ZOOM_OAUTH_CLIENT_SECRET`, fetch `GET https://api.zoom.us/v2/users/me` to get `id` and `account_id`, encrypt tokens via `encrypt()`, and upsert a `zoomConnections` row
- Given an `isOnPrem()` check at the top of each route, should return 404 so the integration is cloud-only
- Given an authenticated user GETting `status`, should return `{ connected: boolean, connection: { zoomEmail, targetDriveId, targetFolderId, includeAiSummary, includeActionItems, includeTranscript } | null }`
- Given an authenticated user POSTing to `disconnect`, should delete the `zoomConnections` row for that user and attempt token revocation via `POST https://zoom.us/oauth/revoke`

---

## Settings API

Create `apps/web/src/app/api/integrations/zoom/settings/route.ts`.

**Requirements**:
- Given an authenticated GET, should return the user's current Zoom connection config fields (`targetDriveId`, `targetFolderId`, `includeAiSummary`, `includeActionItems`, `includeTranscript`)
- Given an authenticated PATCH with a validated body (`targetDriveId`, `targetFolderId`, and the three boolean toggles), should update only the provided fields on the user's `zoomConnections` row
- Given an invalid or missing drive ID, should return 400 with a descriptive error

---

## Zoom API Client

Create `apps/web/src/lib/integrations/zoom/zoom-api-client.ts` following the `google-calendar/api-client.ts` pattern.

**Requirements**:
- Given an access token, `buildAuthHeader` should return `{ Authorization: 'Bearer {token}' }` — access token must never appear in a URL
- Given a meeting UUID, `buildRecordingsUrl` should return `https://api.zoom.us/v2/meetings/{encodedUuid}/recordings` with no user-controlled data in the host segment
- Given a valid access token and meeting UUID, `getRecordings` should fetch from the hardcoded `api.zoom.us` base URL using the Bearer header and return `ZoomApiResult<ZoomRecordingsResponse>`
- Given a 401 or 403 response, `getRecordings` should return `{ success: false, requiresReauth: true }`
- Given a `downloadUrl` whose hostname is not `zoom.us` or a `*.zoom.us` subdomain, `downloadTranscript` should return `{ success: false, error: '...' }` without making any network call
- Given a valid access token and a trusted `downloadUrl`, `downloadTranscript` should fetch using only the `Authorization: Bearer` header — the access token must not appear in the request URL

## Token Refresh

Create `apps/web/src/lib/integrations/zoom/token-refresh.ts` following the `google-calendar/token-refresh.ts` pattern.

**Requirements**:
- Given a null `tokenExpiresAt`, `isTokenExpired` should return false (unknown expiry treated as valid)
- Given a `tokenExpiresAt` in the past or within the 5-minute buffer, `isTokenExpired` should return true
- Given an active connection with a non-expired token, `getValidZoomAccessToken` should return the stored decrypted token without calling the Zoom API
- Given an active connection with an expired token and a valid refresh token, `getValidZoomAccessToken` should POST to `https://zoom.us/oauth/token` with `grant_type=refresh_token`, re-encrypt and store the new token, and return it
- Given an expired token and no refresh token, `getValidZoomAccessToken` should return `{ success: false, requiresReauth: true }`
- Given a failed refresh API call, `getValidZoomAccessToken` should update connection status to `'expired'` and return `{ success: false, requiresReauth: true }`
- Given `processZoomWebhook`, should call `getValidZoomAccessToken` instead of directly decrypting the stored token, so expired tokens are refreshed transparently
- Given a meeting UUID, `buildRecordingsUrl` should return a URL whose path ends with `/recordings`
- Given a non-2xx, non-auth HTTP response, `getRecordings` should return `{ success: false, statusCode: <httpStatus> }` so callers can distinguish error types
- Given `downloadTranscript` encounters a network error (fetch throws), should return `{ success: false, error: message }` without throwing

## Webhook Processor

Create `apps/web/src/lib/integrations/zoom/process-webhook.ts`.

**Requirements**:
- Given a `recording.transcript_completed` event body, should look up the `zoomConnections` row by `zoomAccountId` matching `payload.account_id`
- Given no matching connection or a null `targetDriveId`, should log a warning and return without error (user hasn't configured a target yet)
- Given a matched connection, should decrypt the access token and call `getRecordings(accessToken, meetingUuid)` to re-fetch recording details from the Zoom API — must not use `download_url` from the webhook payload directly
- Given the recordings response, should find the `file_type === 'TRANSCRIPT'` entry and call `downloadTranscript(accessToken, file.download_url)` using Bearer authentication
- Given the VTT content, should run `parseVtt` → plain text for AI calls → `vttToHtml` for the document
- Given `includeAiSummary` is true, should call `generateTranscriptSummary` and include the result
- Given `includeActionItems` is true, should call `extractActionItems` and include the result
- Given assembled content, should create a Document page via internal API call with title `{YYYY-MM-DD} — {topic}`, `driveId: targetDriveId`, `parentId: targetFolderId`, `contentMode: 'html'`

---

## Webhook Route + Middleware

Create `apps/web/src/app/api/integrations/zoom/webhook/route.ts` and add the path to the public routes in `apps/web/middleware.ts`.

**Requirements**:
- Given a POST with `body.event === 'endpoint.url_validation'`, should respond with `handleUrlValidationChallenge` output before any signature check (Zoom's registration handshake)
- Given any other POST, should verify the Zoom HMAC signature and return 401 on failure before any processing
- Given a verified `recording.transcript_completed` event, should return 200 immediately and queue `processZoomWebhook` via `after()` for async processing
- Given `isOnPrem()`, should return 404
- Given `apps/web/middleware.ts`, should add `pathname.startsWith('/api/integrations/zoom/webhook')` to the public routes block so Zoom's server can reach it without a session cookie

---

## Settings UI

Create `apps/web/src/app/settings/integrations/zoom/page.tsx` and add a Zoom card to the integrations index.

**Requirements**:
- Given a disconnected state, should show a Connect button that POSTs to `connect` and redirects to the Zoom OAuth URL
- Given a connected state, should show the connected Zoom email, a drive dropdown, a folder field, and three toggles (AI Summary, Action Items, Full Transcript) all defaulting to on
- Given a privacy note below the toggles, should read: *"Transcript content is processed by your configured AI provider and stays within your workspace."*
- Given `apps/web/src/app/settings/integrations/page.tsx`, should add a Zoom integration card in the same style as the Google Calendar card

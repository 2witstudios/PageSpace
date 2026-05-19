# OpenAI API v1 Follow-Up Epic

**Status**: 🔄 IN PROGRESS (PR #1381)
**Goal**: Close two gaps in the OpenAI-compatible inference API: missing token usage tracking and a missing model discovery endpoint.

## Overview

Why: PR #1377 shipped the `POST /api/v1/chat/completions` endpoint but left two incomplete pieces. First, the `onFinish` callback does not call `AIMonitoring.trackUsage`, so actual input/output token counts are never persisted — only the subscription message counter ticks. Second, there is no `GET /api/v1/models` endpoint; every OpenAI SDK client calls this on startup and crashes if it returns 404, making the API unusable out-of-the-box.

---

## Fix Token Usage Tracking in onFinish

Update `POST /api/v1/chat/completions` to call `AIMonitoring.trackUsage` inside `onFinish` with the real token counts from `totalUsage`.

**Requirements**:
- Given a successful inference, should call `AIMonitoring.trackUsage` with `inputTokens` and `outputTokens` from `totalUsage`
- Given `AIMonitoring.trackUsage` throwing, should log the error and NOT break the SSE stream response
- Given the `onFinish` callback, should include `metadata: { via: 'openai_api_v1' }` to distinguish from browser-initiated chats

---

## Add GET /api/v1/models Endpoint

New `GET /api/v1/models` route that returns AI_CHAT pages accessible to the MCP token as OpenAI Model list objects.

**Requirements**:
- Given an unscoped MCP token, should return all non-trashed AI_CHAT pages without a drive filter
- Given a scoped MCP token, should return only AI_CHAT pages whose `driveId` is in `allowedDriveIds`
- Given a page the user cannot view, should exclude it from the list
- Given an auth failure, should return 401
- Given no accessible AI_CHAT pages, should return `{ object: 'list', data: [] }` with 200
- Given accessible pages, should shape each as `{ id: 'ps-agent://<pageId>', object: 'model', created: <unix>, owned_by: 'pagespace' }`
- Given a valid request, should return `{ object: 'list', data: [...] }` (standard OpenAI envelope)

# OpenAI-Compatible Inference API Epic

**Status**: ✅ COMPLETED (2026-05-18)
**Goal**: Expose PageSpace agents as an OpenAI-compatible HTTP endpoint so developers can use any OpenAI SDK client to call PageSpace agents.

## Overview

Why: PageSpace agents are only reachable through the browser UI or MCP desktop protocol — there is no HTTP API a developer can call the way they call OpenAI. This closes that gap by adding a single route that adapts the existing inference pipeline into the OpenAI wire format. All the hard infrastructure already exists (MCP tokens, auth gate, inference pipeline, metering). This epic is a thin adapter layer on top of it.

---

## Request Validator

Pure `validateInferenceRequest` function that parses and validates the incoming OpenAI-shaped body before any DB or pipeline work.

**TDD**: Write failing tests first. Commit after RED→GREEN. `test(api): request validator tests`, then `feat(api): validateInferenceRequest`.

**Requirements**:
- Given a body with a valid `ps-agent://<pageId>` model and non-empty messages array, should return `{ ok: true, data }` with the parsed request
- Given a body with a missing `model` field, should return `{ ok: false, error: '400: model is required' }`
- Given a body with a `model` that does not start with `ps-agent://`, should return `{ ok: false, error: '400: unsupported model format — use ps-agent://<pageId>' }`
- Given a body with an empty messages array, should return `{ ok: false, error: '400: messages must be a non-empty array' }`
- Given a body with `stream: false`, should return `{ ok: false, error: '400: non-streaming responses not supported in v1' }`
- Given valid input with `drive_context` present, should include `driveContext` in the returned data
- Given valid input with `stream` omitted, should default to `stream: true`

---

## Agent Resolver

Pure `resolveAgent` factory that takes a DB query function and returns a resolver: `(pageId, userId) => Promise<Result<AgentPage>>`.

**TDD**: Write failing tests first. Commit after RED→GREEN. `test(api): agent resolver tests`, then `feat(api): resolveAgent`.

**Requirements**:
- Given a valid `pageId` for an `AI_CHAT` page the user can view, should return `{ ok: true, page }`
- Given a `pageId` that does not exist in the pages table, should return `{ ok: false, status: 404, error: 'Agent not found' }`
- Given a `pageId` for a page with a type other than `AI_CHAT`, should return `{ ok: false, status: 404, error: 'Agent not found' }`
- Given a `pageId` for an `AI_CHAT` page the user cannot view (permission denied), should return `{ ok: false, status: 403, error: 'Access denied' }`
- Given a `model` string of `ps-agent://<pageId>`, should parse the `pageId` correctly using `parseAgentModelUri`

---

## OpenAI Chunk Adapter

Pure `adaptToOpenAIChunk` function that transforms a single Vercel AI SDK `UIMessageChunk` into an OpenAI `ChatCompletionChunk` SSE event string.

**TDD**: Write failing tests first. Commit after RED→GREEN. `test(api): OpenAI chunk adapter tests`, then `feat(api): adaptToOpenAIChunk`.

**Requirements**:
- Given a `text-delta` chunk, should return an SSE line with `delta.content` set to the text delta
- Given a `finish` chunk with `finishReason: 'stop'`, should return an SSE line with `finish_reason: 'stop'` and empty `delta`
- Given a `start` chunk, should return an SSE line for the opening `role: 'assistant'` delta with empty `content`
- Given any chunk, should include a stable `id` (passed as parameter), `model` field, and `created` timestamp in the returned object
- Given a `finish` chunk and the stream encoder appending `\n\n`, should produce exactly two separate SSE events (stop chunk and `[DONE]` sentinel) — not one multi-data event
- Given the final stop chunk, should be followed by the `data: [DONE]` sentinel line
- Given a `tool-call` or `tool-result` chunk, should be skipped (return `null`) — tool calls are not exposed in v1

---

## Inference Route Handler

`POST /api/v1/chat/completions` — wire auth gate + validator + resolver + stripped pipeline + adapter into a single Next.js route handler.

**TDD**: Write integration tests with mocked DB and mocked `streamText` before writing the handler. Commit after RED→GREEN. `test(api): route handler integration tests`, then `feat(api): /v1/chat/completions route`.

**Requirements**:
- Given a request with no `Authorization` header, should return `401 Unauthorized`
- Given a request with a valid MCP Bearer token and a valid body, should return a `200` SSE stream
- Given a valid token but a `model` pointing to a page in a drive outside the token's scope, should return `403 Forbidden`
- Given a valid token but `model` pointing to a non-existent page, should return `404 Not Found`
- Given a valid token and a malformed body (e.g. missing `model`), should return `400 Bad Request` with a JSON error body
- Given a successful inference, should save the user message to `chatMessages` before streaming begins
- Given a successful inference, should save the assistant message to `chatMessages` in `onFinish`
- Given a successful inference, should increment usage via the existing metering infrastructure
- Given a valid request, should NOT require a `X-Browser-Session-Id` header (MCP-only path skips browser session validation)
- Given a valid request, should NOT emit any WebSocket broadcast events (no UI coupling)
- Given a valid streaming response, the SSE output should be parseable by the `openai` npm SDK using `baseURL: 'https://api.pagespace.dev/v1'`
- Given a valid request, should set `maxDuration = 300` to match the existing chat route

---

## Code Quality

**Requirements**:
- `parseAgentModelUri` and `AGENT_MODEL_PREFIX` should have a single canonical definition — no duplicates across modules
- `ValidatedInferenceRequest` should include the validated `model` string so the route handler does not need to re-cast `rawBody`
- The `riteway` test helper should exist in one shared location, not duplicated across test directories

---

## Commit Cadence Rules

These apply throughout the entire epic and are non-negotiable:

- Write failing tests FIRST — no implementation code before a red test exists
- Commit after each task's RED→GREEN cycle with conventional commit format
- Never bundle two tasks into one commit
- Commit message body must state what changed AND why it matters
- Run `pnpm typecheck` and `pnpm test:unit` before each commit; fix failures before committing

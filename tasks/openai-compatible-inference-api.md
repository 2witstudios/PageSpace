# OpenAI-Compatible Inference API Epic

**Status**: 🚧 IN PROGRESS
**Goal**: Let third-party developers call PageSpace agents through the standard OpenAI Chat Completions interface using existing MCP tokens.

## Execution Discipline

- Every task follows strict TDD: write a failing colocated Vitest + Riteway test (RED), implement only enough to pass (GREEN), refactor if needed — no source change without a failing test first.
- Each task lands as its own Conventional Commit (`feat(api): …`, `test(api): …`) on `claude/agents-api-endpoints-task-R7K0B` and is pushed immediately after the task's tests pass.
- Tasks are executed strictly in order; a task is not started until the previous task's tests are green and committed.

## Overview

Developers cannot reach PageSpace agents programmatically today — agents only live behind the browser UI and the MCP desktop protocol — which blocks any external app from treating PageSpace as an AI backend. Every primitive needed already exists (MCP token auth with drive scoping, the full inference pipeline in `apps/web/src/app/api/ai/chat/route.ts`, the provider factory, persistence, and metering); the only gap is an OpenAI-shaped request/response surface, so this epic adds one route plus small pure adapters that compose those primitives, exposing agents as `ps-agent://<pageId>` "models" authenticated by MCP tokens as API keys.

---

## Model Resolver

Resolve an OpenAI `model` string into a concrete agent page.

**Requirements**:
- Given a `model` value using the `ps-agent://<pageId>` scheme, should resolve it to the referenced agent page.
- Given a `model` value that does not use the `ps-agent://` scheme, should reject the request as an invalid model.
- Given a resolved id that points to no page or a page that is not an agent, should reject the request as a model that does not exist.

---

## OpenAI Request Adapter

Validate the incoming OpenAI Chat Completions body and translate it into the internal inference inputs.

**Requirements**:
- Given a body missing the model or the messages, should reject it as a malformed request in OpenAI error shape.
- Given OpenAI-format messages, should produce internal model messages that preserve each message's role and textual content in order.
- Given a body that omits the streaming flag, should treat the request as a streaming request by default.

---

## OpenAI Response Adapter

Pure formatters that shape inference output as OpenAI streaming chunks, a final completion object, and SSE framing.

**Requirements**:
- Given an incremental text delta and the request metadata, should produce a `chat.completion.chunk` whose first choice carries the delta.
- Given the final assembled text and token usage, should produce a `chat.completion` object reporting usage and a stop finish reason.
- Given a sequence of chunks, should frame each as a `data:` SSE event and terminate the stream with the `[DONE]` sentinel.

---

## Inference Context Resolver

A single helper that authenticates the MCP token, resolves the agent, and enforces drive scope, returning either an OpenAI-shaped error or a ready inference context.

**Requirements**:
- Given a request without a valid MCP bearer token, should deny it as unauthorized.
- Given an MCP token whose drive scope excludes the agent's drive, should deny it as forbidden.
- Given a valid in-scope token and a resolvable agent, should return a context carrying the agent page and authenticated user.

---

## Completions Route

The `POST /api/v1/chat/completions` handler composing the adapters, the context resolver, the provider factory, and `streamText` for both streaming and non-streaming responses.

**Requirements**:
- Given a streaming request, should respond with an `text/event-stream` of OpenAI-shaped chunks ending in the `[DONE]` sentinel.
- Given a non-streaming request, should respond with a single OpenAI `chat.completion` JSON body.
- Given a provider or upstream model failure, should respond with an OpenAI-shaped error and an appropriate status.

---

## Persistence And Metering

Record the API exchange through the same persistence and monitoring paths the browser chat uses.

**Requirements**:
- Given a completed API inference, should persist the user and assistant turns under the agent page so the exchange appears in that agent's history.
- Given a completed API inference, should record token usage with provider and model through the existing monitoring path so API traffic is metered like browser traffic.

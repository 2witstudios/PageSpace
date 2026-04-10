# AI System Zero-Trust Audit Report

**Date**: 2026-04-10
**Scope**: All AI subsystems in the PageSpace codebase
**Methodology**: Full code read of every file in the AI system, cross-referenced between files. Every finding verified against multiple source files. No false positives.
**Status**: All 10 findings resolved in PR #872 (`claude/fix-ai-hallucinations-H2xYb`)

---

## Finding 1 — CRITICAL: Read-Only Mode Bypass (7 Write Tools Unfiltered)

**Status**: Resolved in PR #872

**Files**:
- `apps/web/src/lib/ai/core/tool-filtering.ts` (WRITE_TOOLS set)
- `apps/web/src/lib/ai/tools/calendar-write-tools.ts` (6 write tools)
- `apps/web/src/lib/ai/tools/drive-tools.ts:319` (1 write tool)

**What was wrong**: The `WRITE_TOOLS` set that controls read-only mode filtering was missing 7 tools that perform database writes:

| Missing Tool | What It Does |
|---|---|
| `create_calendar_event` | Creates events in the database |
| `update_calendar_event` | Modifies existing events |
| `delete_calendar_event` | Deletes events from the database |
| `rsvp_calendar_event` | Writes RSVP status |
| `invite_calendar_attendees` | Adds attendees to events |
| `remove_calendar_attendee` | Removes attendees from events |
| `update_drive_context` | Writes to `drives.drivePrompt` column |

**Impact**: When a user enabled read-only mode, the AI could still create, modify, and delete calendar events, manage attendees, and overwrite workspace context. The `filterToolsForReadOnly()` function checked against `WRITE_TOOLS`, so these 7 tools passed through unfiltered.

**Fix**: Added all 7 tool identifiers to the `WRITE_TOOLS` set used by `filterToolsForReadOnly()`.

---

## Finding 2 — CRITICAL: Vision Detection Failed for Claude 4.5 Models

**Status**: Resolved in PR #872

**File**: `apps/web/src/lib/ai/core/vision-models.ts`

**What was wrong**: Three Claude 4.5 models registered in the Anthropic provider config (`ai-providers-config.ts:295-297`) were missing from both the explicit vision capability map AND failed the heuristic fallback:

| Model ID (from provider config) | Was In Vision Map? | Was Caught by Heuristic? |
|---|---|---|
| `claude-opus-4-5-20251124` | No | No |
| `claude-sonnet-4-5-20250929` | No | No |
| `claude-haiku-4-5-20251001` | No | No |

**Why the heuristic failed**: The fallback checked `lowerModel.includes('claude-3') || lowerModel.includes('claude-4')`. The model ID `claude-opus-4-5-20251124` does NOT contain the substring `claude-4` because there's `opus-` between `claude-` and `4`. Same for `claude-sonnet-4-` and `claude-haiku-4-`.

**Impact**: When a user selected a Claude 4.5 model and tried to read a visual/image file, the `read_page` tool returned a "switch to a vision-capable model" error instead of sending the image to the AI.

**Fix**: Added all three Claude 4.5 model IDs (plus dotted aliases `claude-opus-4.5`, `claude-sonnet-4.5`, `claude-haiku-4.5`) to the explicit vision map, and expanded the heuristic to also match `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-4` patterns.

---

## Finding 3 — HIGH: Wrong Model IDs in User-Facing Suggestions

**Status**: Resolved in PR #872

**Files**:
- `apps/web/src/lib/ai/core/model-capabilities.ts:150`
- `apps/web/src/lib/ai/core/vision-models.ts:159-163`

**What was wrong**: Two suggestion functions returned model IDs that did not exist in the Anthropic provider config:

- `getSuggestedToolCapableModels('anthropic')` returned `['claude-3-haiku', 'claude-3-5-sonnet']`
- `getSuggestedVisionModels()` returned `['gpt-4o-mini', 'claude-3-haiku', 'gemini-2.5-flash']`

The actual Anthropic model IDs require date suffixes: `claude-3-haiku-20240307`, `claude-3-5-sonnet-20241022`.

**Impact**: Users shown these suggestions could not switch to the recommended models because `isValidModel('anthropic', 'claude-3-haiku')` returned `false`.

**Fix**: Corrected to `claude-3-haiku-20240307` and `claude-3-5-sonnet-20241022` in both functions.

---

## Finding 4 — HIGH: Context Window Calculator Missing GPT-5.3/5.4 Branches

**Status**: Resolved in PR #872

**File**: `packages/lib/src/monitoring/ai-context-calculator.ts`

**What was wrong**: `getContextWindowSize()` had explicit branches for GPT-5.2 (400K) and GPT-5.1 (400K), but GPT-5.3 and GPT-5.4 models fell through to the generic GPT-5.0 catch-all which returned only 272K. This happened because `'gpt-5.4-pro'.includes('gpt-5')` is `true`, matching the GPT-5.0 branch.

**Impact**: Conversation history was prematurely truncated for GPT-5.3/5.4 users.

**Fix**: Added `gpt-5.4` and `gpt-5.3` branches before the `gpt-5` catch-all, both returning 400K.

---

## Finding 5 — HIGH: GPT-4.1 Models Missing from Vision Map + Wrong Context Window

**Status**: Resolved in PR #872

**Files**:
- `apps/web/src/lib/ai/core/vision-models.ts`
- `packages/lib/src/monitoring/ai-context-calculator.ts`

**What was wrong**: Three GPT-4.1 models in the OpenAI provider config were missing from the vision map AND got the wrong context window:

| Model ID | Vision Detection | Context Window |
|---|---|---|
| `gpt-4.1-2025-04-14` | Returned `false` (should be `true`) | Returned 8,192 (should be 1,000,000) |
| `gpt-4.1-mini-2025-04-14` | Returned `false` (should be `true`) | Returned 8,192 (should be 1,000,000) |
| `gpt-4.1-nano-2025-04-14` | Returned `false` (should be `true`) | Returned 8,192 (should be 1,000,000) |

**Why**: `gpt-4.1` didn't match any heuristic (`gpt-4o`, `gpt-5`, etc.) and fell through to the `gpt-4` catch-all in the context calculator which returned the GPT-4 base context of 8K.

**Fix**: Added all three GPT-4.1 models to vision map, added `gpt-4.1` heuristic fallback, and added `gpt-4.1` branch (1M) before the `gpt-4` catch-all (8K) in the context calculator.

---

## Finding 6 — HIGH: @mentions Processed But Not Injected in Page Agent Prompts

**Status**: Resolved in PR #872

**File**: `apps/web/src/app/api/ai/chat/route.ts`

**What was wrong**: The page AI chat route processed @mentions (`processMentionsInMessage(messageContent)`) and logged them, but never called `buildMentionSystemPrompt()` or included the mention prompt in the system prompt. The global assistant route correctly did this.

**Impact**: @mentioning a document in a page agent chat appeared to work (UI resolved the mention, backend logged it) but the AI never received instructions to read the mentioned document.

**Fix**: Added `buildMentionSystemPrompt` import, built the prompt when mentions are found, and included `mentionSystemPrompt` in the system prompt concatenation.

---

## Finding 7 — HIGH: OpenRouter Suggestion Models Not in Config

**Status**: Resolved in PR #872

**File**: `apps/web/src/lib/ai/core/model-capabilities.ts:144`

**What was wrong**: `getSuggestedToolCapableModels()` for OpenRouter suggested `meta-llama/llama-3.1-8b-instruct` and `qwen/qwen-2.5-7b-instruct`, neither of which existed in the PageSpace OpenRouter config. Users could not switch to models not in the dropdown.

**Fix**: Replaced with `meta-llama/llama-3.1-405b-instruct` and `mistralai/mistral-small-3.2-24b-instruct`, both of which exist in the OpenRouter paid config.

---

## Finding 8 — MEDIUM: Hallucinated Model IDs in Vision Map

**Status**: Resolved in PR #872

**File**: `apps/web/src/lib/ai/core/vision-models.ts`

**What was wrong**: Two model IDs in the vision capability map did not exist in any provider config:

- `gpt-5-2025-08-07` — not in any provider config
- `gpt-5-chat-latest` — not in any provider config

These were likely hallucinated by AI when the vision map was generated.

**Fix**: Removed both entries.

---

## Finding 9 — MEDIUM: Tool Summary Display Incomplete (12+ Tools Missing)

**Status**: Resolved in PR #872

**File**: `apps/web/src/lib/ai/core/tool-filtering.ts`

**What was wrong**: `getToolsSummary()` had a hardcoded `allTools` array that was missing 12+ tools that actually exist in the system (6 read tools and the 7 write tools from Finding 1).

**Impact**: The admin global-prompt viewer showed an incomplete picture of what tools the AI has access to.

**Fix**: Added all missing read tools (`list_conversations`, `read_conversation`, `get_assigned_tasks`, `list_calendar_events`, `get_calendar_event`, `check_calendar_availability`) to the allTools array. Write tools were automatically included via `...Array.from(WRITE_TOOLS)` after Finding 1 was fixed.

---

## Finding 10 — MEDIUM: Vision Map Missing xAI Grok 4 Model Variants

**Status**: Resolved in PR #872

**File**: `apps/web/src/lib/ai/core/vision-models.ts`

**What was wrong**: The vision map had `grok-4` and `grok-4-fast`, but the actual xAI provider config registered `grok-4-fast-reasoning`, `grok-4-fast-non-reasoning`, and `grok-code-fast-1` — none of which were in the vision map or caught by heuristics.

**Fix**: Added `grok-4-fast-reasoning`, `grok-4-fast-non-reasoning`, and `grok-code-fast-1` to the explicit vision map.

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Read-only mode bypass (7 calendar/context write tools) | CRITICAL | Resolved in PR #872 |
| 2 | Vision detection fails for Claude 4.5 models | CRITICAL | Resolved in PR #872 |
| 3 | Wrong model IDs in user-facing suggestions | HIGH | Resolved in PR #872 |
| 4 | Context window calculator missing GPT-5.3/5.4 | HIGH | Resolved in PR #872 |
| 5 | GPT-4.1 missing from vision map + context calculator | HIGH | Resolved in PR #872 |
| 6 | @mentions not injected into page agent prompts | HIGH | Resolved in PR #872 |
| 7 | OpenRouter suggestions reference non-existent models | HIGH | Resolved in PR #872 |
| 8 | Hallucinated model IDs in vision map | MEDIUM | Resolved in PR #872 |
| 9 | Tool summary display incomplete (12+ tools) | MEDIUM | Resolved in PR #872 |
| 10 | Vision map missing Grok 4 variants | MEDIUM | Resolved in PR #872 |

All findings verified against source code before and after fixes. All 363 tests pass.

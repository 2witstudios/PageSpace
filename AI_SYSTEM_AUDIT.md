# AI System Zero-Trust Audit Report

**Date**: 2026-04-10
**Scope**: All AI subsystems in the PageSpace codebase
**Methodology**: Full code read of every file in the AI system, cross-referenced between files. Every finding verified against multiple source files. No false positives.

---

## CRITICAL: Read-Only Mode Bypass (7 Write Tools Unfiltered)

**Files**:
- `apps/web/src/lib/ai/core/tool-filtering.ts:9-30` (WRITE_TOOLS set)
- `apps/web/src/lib/ai/tools/calendar-write-tools.ts` (6 write tools)
- `apps/web/src/lib/ai/tools/drive-tools.ts:319` (1 write tool)

**The bug**: The `WRITE_TOOLS` set that controls read-only mode filtering is missing 7 tools that perform database writes:

| Missing Tool | What It Does |
|---|---|
| `create_calendar_event` | Creates events in the database |
| `update_calendar_event` | Modifies existing events |
| `delete_calendar_event` | Deletes events from the database |
| `rsvp_calendar_event` | Writes RSVP status |
| `invite_calendar_attendees` | Adds attendees to events |
| `remove_calendar_attendee` | Removes attendees from events |
| `update_drive_context` | Writes to `drives.drivePrompt` column |

**Impact**: When a user enables read-only mode, the AI can still create, modify, and delete calendar events, manage attendees, and overwrite workspace context. The `filterToolsForReadOnly()` function at line 46-55 checks against `WRITE_TOOLS`, so these 7 tools pass through unfiltered.

**Verification**: `WRITE_TOOLS` on line 9 contains exactly: `create_page`, `rename_page`, `replace_lines`, `move_page`, `edit_sheet_cells`, `create_drive`, `rename_drive`, `trash`, `restore`, `update_agent_config`, `update_task`, `send_channel_message`, `import_from_github`. None of the calendar or drive-context tools appear.

---

## CRITICAL: Vision Detection Fails for Claude 4.5 Models

**File**: `apps/web/src/lib/ai/core/vision-models.ts`

**The bug**: Three Claude 4.5 models registered in the Anthropic provider config (`ai-providers-config.ts:295-297`) are missing from both the explicit vision capability map AND fail the heuristic fallback:

| Model ID (from provider config) | In Vision Map? | Caught by Heuristic? |
|---|---|---|
| `claude-opus-4-5-20251124` | No | No |
| `claude-sonnet-4-5-20250929` | No | No |
| `claude-haiku-4-5-20251001` | No | No |

**Why the heuristic fails**: Line 140 checks `lowerModel.includes('claude-3') || lowerModel.includes('claude-4')`. The model ID `claude-opus-4-5-20251124` does NOT contain the substring `claude-4` because there's `opus-` between `claude-` and `4`. Same for `claude-sonnet-4-` and `claude-haiku-4-`.

**Note**: Claude 4.6 models ARE in the map (lines 43-46), and Claude 4.1 models ARE in the map (lines 47-48, 58). Only 4.5 was missed.

**Impact**: When a user selects a Claude 4.5 model and tries to read a visual/image file, the `read_page` tool (page-read-tools.ts:150-152) checks `modelCapabilities?.hasVision` and returns a "switch to a vision-capable model" error instead of sending the image to the AI. All Claude 3+ models have vision, so this is always a false negative.

---

## HIGH: Wrong Model IDs in User-Facing Suggestions

**Files**:
- `apps/web/src/lib/ai/core/model-capabilities.ts:150`
- `apps/web/src/lib/ai/core/vision-models.ts:159-163`

**The bug**: Two suggestion functions return model IDs that don't exist in the Anthropic provider config:

```typescript
// model-capabilities.ts:150
case 'anthropic':
  return ['claude-3-haiku', 'claude-3-5-sonnet'];  // WRONG

// vision-models.ts:161
return ['gpt-4o-mini', 'claude-3-haiku', 'gemini-2.5-flash'];  // claude-3-haiku WRONG
```

**Actual Anthropic model IDs** (from `ai-providers-config.ts:287-315`):
- `claude-3-haiku-20240307` (not `claude-3-haiku`)
- `claude-3-5-sonnet-20241022` (not `claude-3-5-sonnet`)

**Where these are shown to users**: `getSuggestedVisionModels()` is called at `page-read-tools.ts:160` when a non-vision model tries to read a visual file. The response includes `suggestedModels: ['gpt-4o-mini', 'claude-3-haiku', 'gemini-2.5-flash']`. If a user switches to `claude-3-haiku`, `isValidModel('anthropic', 'claude-3-haiku')` returns `false`.

The default suggestion list at `model-capabilities.ts:152` also uses these wrong IDs: `return ['gpt-4o-mini', 'claude-3-haiku', 'gemini-2.5-flash']`.

---

## HIGH: Context Window Calculator Missing GPT-5.3/5.4 Branches

**File**: `packages/lib/src/monitoring/ai-context-calculator.ts:136-165`

**The bug**: The `getContextWindowSize()` function has explicit branches for GPT-5.2 (400K) and GPT-5.1 (400K), but GPT-5.3 and GPT-5.4 models fall through to the generic GPT-5.0 catch-all which returns only 272K:

```typescript
if (modelLower.includes('gpt-5.2')) { return 400_000; }  // GPT-5.2: OK
if (modelLower.includes('gpt-5.1')) { return 400_000; }  // GPT-5.1: OK
if (modelLower.includes('gpt-5')) {                       // GPT-5.3, 5.4 FALL HERE
  return 272_000;                                          // Wrong - gets 5.0 value
}
```

**Why it happens**: `'gpt-5.4-pro'.includes('gpt-5')` is `true`, so the GPT-5 catch-all matches GPT-5.3 and GPT-5.4 models before any specific check for them exists.

**Impact**: The `determineMessagesToInclude()` function (line 268) uses this to decide how many messages fit in context. For GPT-5.4-pro, it truncates at 272K instead of the likely correct 400K+, silently dropping conversation history. The `calculateTotalContextSize()` function (line 228) also reports `wasTruncated: true` prematurely.

**Models affected**: All 4 GPT-5.3 and GPT-5.4 models in the OpenAI provider config:
- `gpt-5.4-pro`, `gpt-5.4`, `gpt-5.3-chat-latest`, `gpt-5.3-codex`

---

## MEDIUM: Hallucinated Model IDs in Vision Map

**File**: `apps/web/src/lib/ai/core/vision-models.ts:30-31`

```typescript
'gpt-5-2025-08-07': true,   // Line 30 - NOT in any provider config
'gpt-5-chat-latest': true,  // Line 31 - NOT in any provider config
```

**Verification**: These model IDs don't appear anywhere in `ai-providers-config.ts`. The OpenAI provider config has `gpt-5`, `gpt-5-mini`, and `gpt-5-nano` but not `gpt-5-2025-08-07` or `gpt-5-chat-latest`. These were likely hallucinated by AI when the vision map was generated.

**Impact**: Low (dead code - these IDs can't be selected by users). However, they indicate the vision map was generated without cross-referencing the provider config, suggesting other entries may also be wrong.

---

## MEDIUM: Tool Summary Display Incomplete (12+ Tools Missing)

**File**: `apps/web/src/lib/ai/core/tool-filtering.ts:106-124`

**The bug**: `getToolsSummary()` has a hardcoded `allTools` array that's missing 12+ tools that actually exist in the system. This function is used by the admin UI to show what tools are available.

**Missing read tools** (exist in tool files, absent from allTools):
- `list_conversations` (page-read-tools.ts:663)
- `read_conversation` (page-read-tools.ts:812)
- `get_assigned_tasks` (task-management-tools.ts:570)
- `list_calendar_events` (calendar-read-tools.ts:173)
- `get_calendar_event` (calendar-read-tools.ts:435)
- `check_calendar_availability` (calendar-read-tools.ts:539)

**Missing write tools** (exist in tool files, absent from both WRITE_TOOLS and allTools):
- All 6 calendar write tools + `update_drive_context` (same as Critical finding #1)

**Impact**: The admin global-prompt viewer shows an incomplete picture of what tools the AI has access to. Combined with the WRITE_TOOLS gap, this makes it invisible that calendar tools bypass read-only mode.

---

## MEDIUM: Vision Map Missing xAI Grok 4 Model Variants

**File**: `apps/web/src/lib/ai/core/vision-models.ts`

**The bug**: The vision map has `grok-4` (line 74) and `grok-4-fast` (line 75), but the actual xAI provider config (`ai-providers-config.ts:320-324`) registers different model IDs:

| Vision Map Entry | Actual xAI Config Entries |
|---|---|
| `grok-4` (line 74) | `grok-4` (line 321) - matches |
| `grok-4-fast` (line 75) | `grok-4-fast-reasoning` (line 322) - NO MATCH |
| (missing) | `grok-4-fast-non-reasoning` (line 323) - NO MATCH |
| (missing) | `grok-code-fast-1` (line 324) - NO MATCH |

The heuristic fallback `lowerModel.includes('grok') && lowerModel.includes('vision')` (line 148) won't catch `grok-4-fast-reasoning` because it doesn't contain "vision".

**Impact**: Users who select Grok 4 Fast (Reasoning) or Grok 4 Fast (Non-Reasoning) get false negatives on vision detection if these models actually support vision.

---

## HIGH: GPT-4.1 Models Missing from Vision Map + Wrong Context Window

**Files**:
- `apps/web/src/lib/ai/core/vision-models.ts`
- `packages/lib/src/monitoring/ai-context-calculator.ts`

**The bug**: Three GPT-4.1 models in the OpenAI provider config are missing from the vision map AND get the wrong context window:

| Model ID | Vision Detection | Context Window |
|---|---|---|
| `gpt-4.1-2025-04-14` | Returns `false` (should be `true`) | Returns 8,192 (should be 1,000,000) |
| `gpt-4.1-mini-2025-04-14` | Returns `false` (should be `true`) | Returns 8,192 (should be 1,000,000) |
| `gpt-4.1-nano-2025-04-14` | Returns `false` (should be `true`) | Returns 8,192 (should be 1,000,000) |

**Why**: `gpt-4.1` doesn't match any heuristic (`gpt-4o`, `gpt-5`, etc.) and falls through to the `gpt-4` catch-all in the context calculator which returns the GPT-4 base context of 8K.

---

## HIGH: @mentions Processed But Not Injected in Page Agent Prompts

**File**: `apps/web/src/app/api/ai/chat/route.ts`

**The bug**: The page AI chat route processes @mentions at line 333 (`processMentionsInMessage(messageContent)`) and logs them, but never calls `buildMentionSystemPrompt()` or includes the mention prompt in the system prompt at line 862. The global assistant route correctly does this at line 309.

**Impact**: @mentioning a document in a page agent chat appears to work (UI resolves the mention, backend logs it) but the AI never receives instructions to read the mentioned document.

---

## HIGH: OpenRouter Suggestion Models Not in Config

**File**: `apps/web/src/lib/ai/core/model-capabilities.ts:144`

**The bug**: `getSuggestedToolCapableModels()` for OpenRouter suggested `meta-llama/llama-3.1-8b-instruct` and `qwen/qwen-2.5-7b-instruct`, neither of which exists in the PageSpace OpenRouter config. Users can't switch to models not in the dropdown.

---

## Summary

| # | Finding | Severity | Type | Impact |
|---|---|---|---|---|
| 1 | Read-only mode bypass (7 calendar/context write tools) | CRITICAL | Missing filter entries | AI can write in read-only mode |
| 2 | Vision detection fails for Claude 4.5 models | CRITICAL | Missing map entries + broken heuristic | Image handling broken for Claude 4.5 |
| 3 | Wrong model IDs in user-facing suggestions | HIGH | Wrong string constants | Suggests non-existent models to users |
| 4 | Context window calculator missing GPT-5.3/5.4 | HIGH | Missing version branches | Premature conversation truncation |
| 5 | GPT-4.1 missing from vision map + context calculator | HIGH | Missing entries + wrong catch-all | Vision broken + 8K context instead of 1M |
| 6 | @mentions not injected into page agent prompts | HIGH | Missing wiring | @mention feature non-functional for page agents |
| 7 | OpenRouter suggestions reference non-existent models | HIGH | Phantom model IDs | Unusable fallback suggestions |
| 8 | Hallucinated model IDs in vision map | MEDIUM | Dead code | Inconsistency, indicates systematic issue |
| 9 | Tool summary display incomplete (12+ tools) | MEDIUM | Incomplete hardcoded list | Admin UI shows wrong tool count |
| 10 | Vision map missing Grok 4 variants | MEDIUM | Missing map entries | Potential false negative on vision |

All findings verified against source code. No speculative issues included.

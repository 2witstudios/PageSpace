# PageSpace AI Prompt Construction System

> **DEPRECATED**: This document describes the legacy PARTNER/PLANNER/WRITER role system which has been replaced with a simpler read-only toggle. The old role files (`agent-roles.ts`, `role-prompts.ts`, `tool-permissions.ts`) have been removed. The new system uses `tool-filtering.ts` for simple read-only filtering and `system-prompt.ts` for unified prompt building. Tool filtering is now a simple boolean: `isReadOnly` toggles between full access and read-only modes.

This document explains how system prompts are constructed for the PageSpace AI assistant. It covers all source files, data flow, and the final structure that gets sent to the LLM.

## Overview

The PageSpace AI prompt is assembled from multiple sources into a single system prompt. The final payload sent to the AI provider includes:

1. **System Prompt** - Instructions, context, and behavior guidance
2. **Tools** - Available functions the AI can call
3. **Experimental Context** - Runtime metadata passed to tool execution
4. **Messages** - Conversation history

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE AI REQUEST PAYLOAD                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        SYSTEM PROMPT                                 │   │
│  │                                                                      │   │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐   │   │
│  │  │  Base System     │  │ Mention System   │  │ Timestamp System │   │   │
│  │  │  Prompt          │  │ Prompt           │  │ Prompt           │   │   │
│  │  │                  │  │                  │  │                  │   │   │
│  │  │  (from Role      │  │  (if @mentions   │  │  (current date/  │   │   │
│  │  │   Prompt Builder)│  │   in message)    │  │   time context)  │   │   │
│  │  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘   │   │
│  │           │                     │                     │              │   │
│  │           └──────────┬──────────┴──────────┬──────────┘              │   │
│  │                      │                     │                         │   │
│  │                      ▼                     ▼                         │   │
│  │  ┌──────────────────────────────────────────────────────────────┐   │   │
│  │  │                    INLINE INSTRUCTIONS                        │   │   │
│  │  │                                                               │   │   │
│  │  │   Page Context: buildInlineInstructions()                     │   │   │
│  │  │        OR                                                     │   │   │
│  │  │   Dashboard/Drive Context: buildGlobalAssistantInstructions() │   │   │
│  │  └──────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                           TOOLS                                      │   │
│  │                                                                      │   │
│  │  pageSpaceTools (ai-tools.ts) → ToolPermissionFilter → Filtered     │   │
│  │                                                                      │   │
│  │  Tool Categories:                                                    │   │
│  │  • driveTools        • pageReadTools      • pageWriteTools          │   │
│  │  • searchTools       • taskManagementTools • agentTools             │   │
│  │  • agentCommunicationTools • webSearchTools                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    EXPERIMENTAL CONTEXT                              │   │
│  │                                                                      │   │
│  │  { userId, locationContext, modelCapabilities }                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         MESSAGES                                     │   │
│  │                                                                      │   │
│  │  [ { role: 'user'|'assistant', content: '...' }, ... ]              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Source Files

### Core Prompt Construction

| File | Purpose |
|------|---------|
| `apps/web/src/lib/ai/complete-request-builder.ts` | Assembles all components into final payload |
| `apps/web/src/lib/ai/role-prompts.ts` | Role-specific prompt templates (PARTNER, PLANNER, WRITER) |
| `apps/web/src/lib/ai/inline-instructions.ts` | Context-specific instructions (page vs. dashboard) |
| `apps/web/src/lib/ai/tool-instructions.ts` | Comprehensive tool usage guidelines |
| `apps/web/src/lib/ai/timestamp-utils.ts` | Current date/time context |
| `apps/web/src/lib/ai/mention-processor.ts` | @mention handling and instructions |

### Role and Permission System

| File | Purpose |
|------|---------|
| `apps/web/src/lib/ai/agent-roles.ts` | Role definitions (PARTNER, PLANNER, WRITER) |
| `apps/web/src/lib/ai/tool-permissions.ts` | Tool filtering based on role permissions |

### Tool Definitions

| File | Purpose |
|------|---------|
| `apps/web/src/lib/ai/ai-tools.ts` | Aggregates all tool categories |
| `apps/web/src/lib/ai/tools/drive-tools.ts` | list_drives, create_drive, rename_drive, trash_drive, restore_drive |
| `apps/web/src/lib/ai/tools/page-read-tools.ts` | list_pages, read_page |
| `apps/web/src/lib/ai/tools/page-write-tools.ts` | create_page, rename_page, replace_lines, insert_lines, trash_page, restore_page, move_page, list_trash |
| `apps/web/src/lib/ai/tools/search-tools.ts` | regex_search, glob_search, multi_drive_search, search_pages |
| `apps/web/src/lib/ai/tools/web-search-tools.ts` | web_search |
| `apps/web/src/lib/ai/tools/task-management-tools.ts` | create_task_list, get_task_list, update_task_status, add_task, resume_task_list |
| `apps/web/src/lib/ai/tools/agent-tools.ts` | create_agent, update_agent_config |
| `apps/web/src/lib/ai/tools/agent-communication-tools.ts` | ask_agent, list_agents, multi_drive_list_agents |

---

## Part 1: System Prompt Construction

The system prompt is built by `RolePromptBuilder.buildSystemPrompt()` and then concatenated with additional context.

### 1.1 Base System Prompt Structure

```typescript
// From complete-request-builder.ts
const baseSystemPrompt = RolePromptBuilder.buildSystemPrompt(
  role,           // PARTNER | PLANNER | WRITER
  contextType,    // 'dashboard' | 'drive' | 'page'
  contextInfo     // Drive/page location info
);
```

The base prompt assembles these sections:

```
# PAGESPACE AI

[Role Core Identity]

[Context Prompt - Dashboard/Drive/Page specific]

[Role Behavior]

[Role Tone]

[Role Constraints]

[Post-Tool Execution Guidance]

# TOOL REFERENCE
You have access to tools for navigating, reading, writing, searching, and organizing the workspace.

## Available Tool Patterns:
• Navigation: list_drives, list_pages, read_page
• Writing: create_page, replace_lines, insert_lines
• Search: glob_search (structure), regex_search (content), search_pages (concepts)
• Organization: move_page, rename_page, trash_page, create_task_list
• AI Agents: create_agent, update_agent_config

## Technical Details:
[Role-Specific Tool Instructions from tool-instructions.ts]
```

### 1.2 Role Prompts

Each role has five prompt components defined in `role-prompts.ts`:

#### PARTNER Role (Default)
```typescript
{
  core: "You are PageSpace AI - think 'Cursor for Google Drive'. You're a collaborative partner...",
  behavior: "APPROACH: Read the situation - sometimes people want to brainstorm...",
  tone: "CONVERSATION: Like a knowledgeable colleague who's genuinely interested...",
  constraints: "GUIDELINES: Use your judgment about when and how to use tools...",
  postToolExecution: "AFTER USING TOOLS: Share what you found or did..."
}
```

#### PLANNER Role (Read-Only)
```typescript
{
  core: "You are a strategic planning assistant focused on analysis and planning. You have read-only access...",
  behavior: "PLANNING PRIORITIES: 1. DISCOVER EVERYTHING: Use all search tools in parallel...",
  tone: "ANALYTICAL STYLE: Thoughtful, thorough, and methodical...",
  constraints: "PLANNING CONSTRAINTS: READ-ONLY: Cannot modify, create, or delete content...",
  postToolExecution: "AFTER EXPLORATION: 1. Present findings... 2. Identify patterns..."
}
```

#### WRITER Role (Execution-Focused)
```typescript
{
  core: "You are an execution-focused assistant. Your job is to efficiently complete tasks...",
  behavior: "EXECUTION PRIORITIES: 1. ACT IMMEDIATELY: Start tool execution within first response...",
  tone: "EFFICIENT STYLE: Concise, direct, and action-oriented...",
  constraints: "EXECUTION GUIDELINES: Act on clear instructions without confirmation...",
  postToolExecution: "AFTER COMPLETION: ✓ Done. [Brief summary]. What's next?"
}
```

### 1.3 Context Prompts

The context prompt varies based on where the AI is invoked:

#### Dashboard Context
```
🌍 DASHBOARD CONTEXT:
• Operating across all workspaces
• Focus on cross-workspace tasks and personal productivity
• Help with workspace organization and global content management
```

#### Drive Context
```
📁 DRIVE CONTEXT:
• Current Workspace: "Marketing Team" (ID: clq2n3..., Slug: marketing)
• Default scope: All operations target this workspace unless specified otherwise
• When users mention "here" or "this workspace", they mean: marketing
```

#### Page Context
```
📍 PAGE CONTEXT:
• Current Location: /Projects/Alpha/Requirements
• Page Type: DOCUMENT
• Breadcrumb: Projects → Alpha → Requirements
• Default scope: Operations relative to this page location unless specified otherwise
• When users say "here", they mean: /Projects/Alpha/Requirements
```

### 1.4 Additional Prompt Sections

After the base system prompt, these sections are concatenated:

#### Mention System Prompt (Conditional)
If the user's message contains @mentions like `@[My Document](clx123:page)`:
```
IMPORTANT: The user has @mentioned the following documents in their message:
- "My Document" (clx123)

You MUST:
1. Use the read_page tool to read each mentioned document BEFORE formulating your response
2. Let the content of these documents inform and enrich your answer
...
```

#### Timestamp System Prompt
```
CURRENT TIMESTAMP CONTEXT:
• Current date and time: Monday, November 25, 2025 at 3:45:00 PM UTC
• When discussing schedules, deadlines, or time-sensitive matters, use this as your reference point
• For relative time references (e.g., "today", "tomorrow", "this week"), calculate from the current timestamp above
```

#### Inline Instructions
The largest section, containing detailed behavioral rules:

**For Page Context** (`buildInlineInstructions()`):
- Critical nesting principle (any page type can contain any other)
- Important behavior rules (page-first exploration)
- Page types and strategic usage
- When to create each page type
- Available tools and when to use them
- Advanced page creation strategies
- Multi-step workflow examples
- Creative nesting examples
- Critical post-tool execution behavior
- Mention processing instructions

**For Dashboard/Drive Context** (`buildGlobalAssistantInstructions()`):
- Task management instructions
- Critical nesting principle
- Context-aware behavior (if in a drive)
- Smart exploration rules
- Mention processing instructions

### 1.5 Final System Prompt Assembly

```typescript
// From complete-request-builder.ts
const systemPrompt = baseSystemPrompt + mentionSystemPrompt + timestampSystemPrompt + inlineInstructions;
```

**Total system prompt length: ~5,000-8,000 tokens** depending on role and context.

---

## Part 2: Tool System

### 2.1 Tool Categories

All 33 tools are aggregated in `ai-tools.ts`:

```typescript
export const pageSpaceTools = {
  ...driveTools,           // 4 tools
  ...pageReadTools,        // 2 tools
  ...pageWriteTools,       // 8 tools
  ...searchTools,          // 4 tools
  ...taskManagementTools,  // 5 tools
  ...agentTools,           // 2 tools
  ...agentCommunicationTools, // 3 tools
  ...webSearchTools,       // 1 tool
};
```

### 2.2 Tool Permission Filtering

Tools are filtered based on agent role permissions:

| Tool Operation | PARTNER | PLANNER | WRITER |
|---------------|---------|---------|--------|
| READ/EXPLORE  | ✅      | ✅      | ✅     |
| WRITE/CREATE/ORGANIZE | ✅ | ❌ | ✅ |
| DELETE        | ✅      | ❌      | ✅     |

**Tool operation classifications** (from `tool-permissions.ts`):

```typescript
export enum ToolOperation {
  READ = 'read',       // read_page, regex_search, etc.
  WRITE = 'write',     // replace_lines, rename_page, etc.
  DELETE = 'delete',   // trash_page, trash_drive
  CREATE = 'create',   // create_page, create_agent, etc.
  ORGANIZE = 'organize', // move_page, restore_page
  EXPLORE = 'explore'  // list_drives, list_pages, list_trash
}
```

### 2.3 Role-Specific Tool Access

**PARTNER Role** (all 33 tools):
- Full access to all tools
- Destructive actions (trash_page) prompt user confirmation
- Collaborative, balanced tool usage

**PLANNER Role** (~15 tools):
- Read-only tools: list_drives, list_pages, read_page
- Search tools: regex_search, glob_search, multi_drive_search, search_pages, web_search
- Exploration: list_trash, list_agents, multi_drive_list_agents
- Task management: create_task_list, get_task_list (read operations)
- **NO write, create, or delete operations**

**WRITER Role** (all 33 tools):
- Same access as PARTNER
- Skips confirmation prompts
- Concise output, execution-focused

### 2.4 Tool Instructions

The `tool-instructions.ts` file provides comprehensive usage guidelines organized by category:

1. **Workspace Navigation** (Priority 1) - How to navigate drives and pages
2. **Document Operations** (Priority 2) - When to use replace_lines vs insert_lines
3. **Search Strategies** (Priority 3) - Which search tool for which situation
4. **Task Management** (Priority 4) - When and how to use task lists
5. **AI Agent Management** (Priority 6) - Creating and configuring agents
6. **Parallel Execution** (Priority 7) - Performance optimization patterns
7. **Error Recovery** (Priority 8) - Handling failures gracefully

Each category includes:
- Detailed instructions
- Code examples
- Error patterns and recovery strategies

---

## Part 3: Experimental Context

Runtime metadata passed to tool execution functions:

```typescript
const experimental_context = {
  userId: 'user-id-here',
  locationContext: {
    currentDrive?: {
      id: string;
      name: string;
      slug: string;
    };
    currentPage?: {
      id: string;
      title: string;
      type: string;
      path: string;
    };
    breadcrumbs?: Array<{ id: string; title: string }>;
  },
  modelCapabilities: {
    supportsStreaming: true,
    supportsToolCalling: true,
    hasVision: false,
  },
};
```

This context is used by tool execute functions to:
- Verify user permissions
- Determine current location scope
- Check model capabilities before operations

---

## Part 4: Final Payload Structure

The complete AI request sent to the provider:

```typescript
interface CompleteAIRequest {
  model: string;                    // e.g., 'openrouter/anthropic/claude-sonnet-4'
  system: string;                   // Complete system prompt (~5,000-8,000 tokens)
  tools: ToolDefinition[];          // Filtered tools with JSON schemas (~3,000-5,000 tokens)
  messages: Message[];              // Conversation history
  experimental_context: Context;    // Runtime metadata (~100-200 tokens)
}
```

**Total context window usage:**
- System prompt: ~5,000-8,000 tokens
- Tool definitions: ~3,000-5,000 tokens
- Experimental context: ~100-200 tokens
- **Base overhead: ~8,000-13,000 tokens** before conversation history

---

## Part 5: Viewing the Complete Prompt

### Admin Global Prompt Viewer

Navigate to `/admin/global-prompt` to see:

1. **Prompt Explorer** - Interactive cards for each component:
   - Role selector with permission summary
   - Expandable prompt sections with source file annotations
   - Tool definitions with JSON schemas
   - Experimental context display

2. **Complete LLM Payload** - The exact formatted string sent to the AI:
   - Token breakdown (system prompt / tools / context / total)
   - Copy-to-clipboard functionality
   - Expandable raw view

3. **Context Picker** - Switch between:
   - Dashboard context
   - Drive context (select a drive)
   - Page context (select a drive and page)

This viewer uses the same `buildCompleteRequest()` function as the actual chat route, ensuring what you see matches what the AI receives.

---

## Summary

The PageSpace AI prompt construction follows this flow:

```
User sends message
       │
       ▼
┌──────────────────┐
│ Determine Role   │ PARTNER / PLANNER / WRITER
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Determine Context│ Dashboard / Drive / Page
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│                  Build System Prompt                          │
│                                                              │
│  RolePromptBuilder.buildSystemPrompt(role, context)          │
│       ↓                                                      │
│  + buildMentionSystemPrompt() (if @mentions present)         │
│       ↓                                                      │
│  + buildTimestampSystemPrompt()                              │
│       ↓                                                      │
│  + buildInlineInstructions() OR buildGlobalAssistantInstructions() │
└────────┬─────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│ Filter Tools     │ ToolPermissionFilter.filterTools(pageSpaceTools, role)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Build Context    │ userId, locationContext, modelCapabilities
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│                  Send to AI Provider                          │
│                                                              │
│  { model, system, tools, messages, experimental_context }    │
└──────────────────────────────────────────────────────────────┘
```

Each component is designed to be modular and maintainable:
- **Role prompts** define personality and approach
- **Context prompts** provide location awareness
- **Inline instructions** teach specific behaviors
- **Tool instructions** explain when/how to use each tool
- **Permission filtering** enforces role capabilities

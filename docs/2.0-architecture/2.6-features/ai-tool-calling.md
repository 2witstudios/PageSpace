# AI Tool Calling Architecture

## Overview

PageSpace's AI tool calling system provides sophisticated workspace automation through the Vercel AI SDK. AI assistants can execute 13+ powerful tools to read, create, modify, and organize content across the entire workspace hierarchy while respecting permissions and maintaining audit trails.

## Core Architecture

### Tool Integration Framework

```typescript
// Core tool execution pattern
const result = await streamText({
  model,
  system: systemPrompt,
  messages: convertToModelMessages(sanitizedMessages),
  tools: filteredTools,  // Permission-based tool filtering
  stopWhen: stepCountIs(100), // Allow complex multi-step operations
  experimental_context: {
    userId,
    modelCapabilities: getModelCapabilities(currentModel, currentProvider)
  },
  maxRetries: 20 // Enhanced retry for rate limits
});
```

### Tool Execution Context

Every tool execution includes rich context for permission validation and feature detection:

```typescript
interface ToolExecutionContext {
  userId: string;
  modelCapabilities: {
    hasVision: boolean;
    hasTools: boolean;
    model: string;
    provider: string;
  };
  locationContext?: {
    currentPage?: { id: string; title: string; type: string };
    driveId?: string;
    driveName?: string;
    driveSlug?: string;
  };
  agentCallDepth?: number; // For nested agent communication
  currentAgentId?: string;
}
```

## Permission-Based Tool Filtering

### Role-Based Access Control

AI tools are filtered based on agent roles with granular permissions:

```typescript
enum AgentRole {
  PARTNER = 'PARTNER',   // Full workspace capabilities
  PLANNER = 'PLANNER',   // Read-only strategic planning
  WRITER = 'WRITER'      // Execution-focused with minimal conversation
}

// Role permissions applied to tools
const ROLE_PERMISSIONS = {
  PARTNER: {
    canRead: true, canWrite: true, canDelete: true,
    allowedOperations: ['read', 'write', 'create', 'update', 'delete', 'organize']
  },
  PLANNER: {
    canRead: true, canWrite: false, canDelete: false,
    allowedOperations: ['read', 'analyze', 'plan', 'explore']
  },
  WRITER: {
    canRead: true, canWrite: true, canDelete: true,
    allowedOperations: ['read', 'write', 'create', 'update', 'delete', 'execute']
  }
};
```

### Custom Tool Configuration

Pages can configure custom tool sets via the `enabledTools` array:

```typescript
// Page-specific tool filtering
let filteredTools;
if (enabledTools && enabledTools.length > 0) {
  const filtered: Record<string, any> = {};
  for (const toolName of enabledTools) {
    if (toolName in pageSpaceTools) {
      filtered[toolName] = pageSpaceTools[toolName];
    }
  }
  filteredTools = filtered;
} else {
  // Default role-based filtering
  filteredTools = ToolPermissionFilter.filterTools(pageSpaceTools, AgentRole.PARTNER);
}
```

## Tool Categories

### 1. Core Page Operations
- **list_drives**: Explore workspace structure
- **list_pages**: Navigate page hierarchies
- **read_page**: Access document content
- **create_page**: Generate new content (all page types)
- **rename_page**: Update page titles
- **trash_page/restore_page**: Manage page lifecycle

### 2. Content Editing Tools
- **replace_lines**: Precise line-based editing
- **insert_lines**: Add content at specific positions
- **append_to_page/prepend_to_page**: Content addition
- **move_page**: Reorganize page structure

### 3. Advanced Search & Discovery
- **regex_search**: Pattern-based content search
- **glob_search**: Structural discovery (e.g., `**/README*`)
- **multi_drive_search**: Cross-workspace search

### 4. Task Management System
- **create_task_list**: Persistent task tracking
- **get_task_list/update_task_status**: Progress management
- **add_task/add_task_note**: Dynamic task expansion
- **resume_task_list**: Cross-session continuity

### 5. Batch Operations
- **bulk_delete_pages**: Mass page deletion
- **bulk_update_content**: Atomic content updates
- **bulk_move_pages**: Mass reorganization
- **bulk_rename_pages**: Pattern-based renaming
- **create_folder_structure**: Complex hierarchy creation

### 6. Agent Management
- **list_agents/multi_drive_list_agents**: Discover AI agents
- **ask_agent**: Agent-to-agent communication
- **create_agent**: Configure new AI assistants
- **update_agent_config**: Modify agent settings

## Tool Execution Flow

### 1. Tool Permission Validation

```typescript
// Permission check for each tool execution
const accessLevel = await getUserAccessLevel(userId, pageId);
if (!canUserEditPage(userId, pageId)) {
  throw new Error('Insufficient permissions for this operation');
}
```

### 2. Tool Execution with Context

```typescript
// Tools receive execution context for intelligent behavior
const toolResult = await toolFunction(args, {
  experimental_context: {
    userId,
    modelCapabilities,
    locationContext,
    agentCallDepth: 0
  }
});
```

### 3. Result Processing and Storage

```typescript
// Tool results are preserved in message history
const extractedToolCalls = extractToolCalls(responseMessage);
const extractedToolResults = extractToolResults(responseMessage);

await saveMessageToDatabase({
  messageId,
  pageId: chatId,
  userId: null, // AI message
  role: 'assistant',
  content: messageContent,
  toolCalls: extractedToolCalls.length > 0 ? extractedToolCalls : undefined,
  toolResults: extractedToolResults.length > 0 ? extractedToolResults : undefined,
  uiMessage: responseMessage, // Complete UIMessage for part ordering
  agentRole: page.title || 'Page AI'
});
```

## Model Capability Detection

### Vision Capability Checking

```typescript
// Automatic vision capability detection
export function hasVisionCapability(model: string): boolean {
  // Direct lookup for known models
  if (model in VISION_CAPABLE_MODELS) {
    return VISION_CAPABLE_MODELS[model];
  }

  // Pattern-based detection
  const lowerModel = model.toLowerCase();
  if (lowerModel.includes('vision') ||
      lowerModel.includes('gpt-4o') ||
      lowerModel.includes('claude-3') ||
      lowerModel.includes('gemini')) {
    return true;
  }

  return false;
}
```

### Tool Capability Validation

```typescript
// Runtime tool capability checking
export async function hasToolCapability(model: string, provider: string): Promise<boolean> {
  // Check cache first
  const cacheKey = `${provider}:${model}`;
  if (toolCapabilityCache.has(cacheKey)) {
    return toolCapabilityCache.get(cacheKey)!;
  }

  // For OpenRouter, check their API for authoritative data
  if (provider === 'openrouter') {
    const openRouterCapabilities = await fetchOpenRouterToolCapabilities();
    const hasTools = openRouterCapabilities.get(model) || false;
    toolCapabilityCache.set(cacheKey, hasTools);
    return hasTools;
  }

  // Pattern-based fallback
  return !model.toLowerCase().includes('gemma'); // Gemma models lack tool support
}
```

## Agent Communication System

### Agent-to-Agent Tool Calls

The `ask_agent` tool enables sophisticated AI collaboration:

```typescript
// Agent consultation with context preservation
const agentResponse = await ask_agent({
  agentPath: "/finance/Budget Analyst",
  agentId: "agent-123",
  question: "What's our Q4 budget status?",
  context: "Preparing board presentation"
});

// Response includes agent metadata
{
  success: true,
  agent: "Budget Analyst",
  response: "Q4 budget shows 15% under target...",
  metadata: {
    processingTime: 2340,
    toolCalls: 3,
    callDepth: 2,
    provider: "Claude 3.5 Sonnet",
    model: "claude-3-5-sonnet-20241022"
  }
}
```

### Multi-Level Agent Discovery

```typescript
// Discover agents across workspace
const agents = await multi_drive_list_agents({
  includeSystemPrompt: false,
  includeTools: true,
  groupByDrive: true
});

// Results grouped by workspace
{
  totalCount: 8,
  driveCount: 3,
  agentsByDrive: [
    {
      driveName: "Marketing",
      agentCount: 3,
      agents: [
        {
          title: "Content Strategy AI",
          path: "/marketing/Content Strategy AI",
          enabledTools: ["create_page", "read_page", "bulk_update_content"],
          hasConversationHistory: true
        }
      ]
    }
  ]
}
```

## Advanced Tool Features

### Recursive Depth Control

Agent communication includes depth tracking to prevent infinite loops:

```typescript
const MAX_AGENT_DEPTH = 3;

// Check call depth before agent consultation
const callDepth = executionContext?.agentCallDepth || 0;
if (callDepth >= MAX_AGENT_DEPTH) {
  throw new Error(`Maximum agent consultation depth (${MAX_AGENT_DEPTH}) exceeded`);
}

// Pass incremented depth to nested calls
const nestedContext = {
  ...executionContext,
  agentCallDepth: callDepth + 1
};
```

### Context Window Management

Conversation history is limited for performance:

```typescript
const MAX_CONVERSATION_WINDOW = 50;

// Load limited message history for agent context
const agentHistory = await db.select()
  .from(chatMessages)
  .where(and(
    eq(chatMessages.pageId, agentId),
    eq(chatMessages.isActive, true)
  ))
  .orderBy(asc(chatMessages.createdAt))
  .limit(MAX_CONVERSATION_WINDOW);
```

### Real-Time Broadcasting

Tool operations broadcast updates for live collaboration:

```typescript
// Broadcast page changes to all connected users
await broadcastPageEvent({
  type: 'page_created',
  pageId: newPage.id,
  driveId: page.driveId,
  userId,
  metadata: {
    title: page.title,
    type: page.type,
    parentId: page.parentId
  }
});
```

## Error Handling & Resilience

### Tool Execution Errors

```typescript
// Comprehensive error capture
const toolErrors = response.steps?.flatMap(step =>
  step.content?.filter(part => part.type === 'tool-error') || []
) || [];

if (toolErrors.length > 0) {
  loggers.ai.warn('Sub-agent tool execution errors:', {
    agentId,
    errors: toolErrors,
  });
}
```

### Retry Logic

```typescript
// Enhanced retry configuration
const aiResult = streamText({
  model,
  tools: filteredTools,
  maxRetries: 20, // Increased from default 2 for rate limit handling
  stopWhen: stepCountIs(100) // Allow complex multi-step operations
});
```

## Monitoring & Analytics

### Tool Usage Tracking

```typescript
// Track individual tool usage
for (const toolCall of extractedToolCalls) {
  await AIMonitoring.trackToolUsage({
    userId: userId!,
    provider: currentProvider,
    model: currentModel,
    toolName: toolCall.toolName,
    toolId: toolCall.toolCallId,
    conversationId: chatId,
    pageId: chatId,
    success: true
  });
}

// Track feature usage patterns
trackFeature(userId!, 'ai_tools_used', {
  toolCount: extractedToolCalls.length,
  provider: currentProvider,
  model: currentModel
});
```

### Audit Trail Logging

```typescript
// Complete audit trail for agent interactions
await logAgentInteraction({
  requestingUserId: userId,
  requestingAgent: executionContext?.locationContext?.currentPage?.id,
  targetAgent: agentId,
  question,
  success: true
});
```

## Implementation Benefits

### Compared to Basic AI Assistants

**Traditional Approach:**
```
User → AI → Text Response
```

**PageSpace Tool-Enhanced Approach:**
```
User → AI → Tool Execution → Workspace Changes → Contextual Response
        ↓
   Permission Validation
   Real-time Broadcasting
   Audit Trail Logging
   Cross-Agent Communication
```

### Key Advantages

1. **Workspace Integration**: AI can directly manipulate workspace content
2. **Permission Aware**: All operations respect user access controls
3. **Multi-Step Operations**: Complex workflows via tool chaining
4. **Agent Collaboration**: AI agents can consult each other
5. **Audit Trails**: Complete history of AI-driven changes
6. **Real-Time Sync**: Live updates across all connected users
7. **Context Preservation**: Tools understand workspace hierarchy
8. **Capability Detection**: Automatic model feature detection
9. **Error Resilience**: Comprehensive retry and error handling
10. **Performance Optimized**: Caching and context window management

This architecture transforms AI from a simple chat interface into a powerful workspace automation system that can handle complex, multi-step operations while maintaining data consistency, security, and collaborative features.
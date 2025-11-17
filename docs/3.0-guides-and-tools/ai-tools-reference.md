# AI Tools Reference Guide

## Overview

PageSpace AI assistants have access to 13+ powerful tools for workspace automation, content management, and collaboration. This comprehensive reference covers all available tools, their parameters, usage patterns, and permission requirements.

## Table of Contents

1. [Core Page Operations](#core-page-operations)
2. [Content Editing Tools](#content-editing-tools)
3. [Advanced Search & Discovery](#advanced-search--discovery)
4. [Task Management System](#task-management-system)
5. [Agent Management](#agent-management)
6. [Tool Permissions](#tool-permissions)
7. [Usage Examples](#usage-examples)

---

## Core Page Operations

### list_drives

**Purpose:** List all accessible workspaces/drives
**Permission Level:** Read
**Use Cases:** Workspace discovery, cross-drive operations

```typescript
list_drives()
```

**Response:**
```json
{
  "success": true,
  "drives": [
    {
      "id": "drive-123",
      "name": "Marketing",
      "slug": "marketing",
      "description": "Marketing team workspace",
      "memberCount": 5,
      "pageCount": 23,
      "isOwner": true
    }
  ],
  "totalCount": 3
}
```

**When to Use:**
- Initial workspace exploration
- Cross-drive content operations
- Understanding available workspaces

---

### list_pages

**Purpose:** Navigate page hierarchies within drives
**Permission Level:** Read
**Use Cases:** Content discovery, structure exploration

```typescript
list_pages({
  driveSlug: "marketing",
  driveId: "drive-123",
  parentId?: "page-456", // Optional: list children of specific page
  includeContent?: false, // Optional: include page content
  maxDepth?: 3 // Optional: limit recursion depth
})
```

**Response:**
```json
{
  "success": true,
  "driveId": "drive-123",
  "driveName": "Marketing",
  "totalPages": 15,
  "tree": [
    {
      "id": "page-123",
      "title": "Campaign Strategy",
      "type": "FOLDER",
      "path": "/marketing/Campaign Strategy",
      "hasChildren": true,
      "children": [
        {
          "id": "page-456",
          "title": "Q1 Campaign",
          "type": "DOCUMENT",
          "path": "/marketing/Campaign Strategy/Q1 Campaign",
          "hasChildren": false
        }
      ]
    }
  ]
}
```

**When to Use:**
- **Always start here** when working with content
- Understanding workspace structure
- Finding specific pages or folders
- Preparing for bulk operations

---

### read_page

**Purpose:** Access document content with metadata
**Permission Level:** Read
**Use Cases:** Content analysis, information gathering

```typescript
read_page({
  pageId: "page-123"
})
```

**Response:**
```json
{
  "success": true,
  "page": {
    "id": "page-123",
    "title": "Campaign Strategy",
    "type": "DOCUMENT",
    "content": "# Q1 Marketing Campaign\n\nObjectives:\n- Increase brand awareness...",
    "path": "/marketing/Campaign Strategy",
    "parentPath": "/marketing",
    "createdAt": "2024-01-15T10:00:00Z",
    "updatedAt": "2024-01-20T14:30:00Z",
    "wordCount": 1250,
    "hasChildren": false
  }
}
```

**When to Use:**
- Reading document content before editing
- Gathering context for AI responses
- Content analysis and summarization

---

### create_page

**Purpose:** Create new pages of any type with optional AI agent configuration
**Permission Level:** Write
**Use Cases:** Content creation, workspace organization

```typescript
create_page({
  driveId: "drive-123",
  title: "New Document",
  type: "DOCUMENT", // DOCUMENT, FOLDER, AI_CHAT, CHANNEL, CANVAS
  parentId?: "page-456", // Optional: parent page
  content?: "Initial content...", // Optional: initial content
  position?: 1, // Optional: position within parent

  // AI Agent Configuration (for AI_CHAT pages only)
  systemPrompt?: "You are a marketing assistant...",
  enabledTools?: ["create_page", "read_page", "replace_lines", "insert_lines"],
  aiProvider?: "anthropic",
  aiModel?: "claude-3-5-sonnet-20241022"
})
```

**Response:**
```json
{
  "success": true,
  "page": {
    "id": "page-789",
    "title": "New Document",
    "type": "DOCUMENT",
    "path": "/marketing/Campaign Strategy/New Document",
    "parentId": "page-456",
    "position": 1
  },
  "agentConfigured": false // true if AI agent was configured
}
```

**Page Types:**
- **DOCUMENT**: Rich text documents, reports, notes
- **FOLDER**: Organizational containers
- **AI_CHAT**: AI assistant conversations with custom configuration
- **CHANNEL**: Team discussion spaces
- **CANVAS**: Custom HTML/CSS pages for dashboards, landing pages

**When to Use:**
- Creating new content
- Setting up project structures
- Creating specialized AI assistants
- Building custom dashboards

---

### rename_page

**Purpose:** Update page titles
**Permission Level:** Edit
**Use Cases:** Organization, clarification

```typescript
rename_page({
  pageId: "page-123",
  title: "Updated Campaign Strategy"
})
```

---

### trash_page

**Purpose:** Move pages to trash (soft delete)
**Permission Level:** Delete
**Use Cases:** Content cleanup, organization

```typescript
// Delete single page
trash_page({
  pageId: "page-123"
})

// Delete page and all children recursively
trash_page({
  pageId: "page-123",
  withChildren: true
})
```

---

### restore_page

**Purpose:** Restore pages from trash
**Permission Level:** Edit
**Use Cases:** Content recovery

```typescript
restore_page({
  pageId: "page-123"
})
```

---

### move_page

**Purpose:** Reorganize page hierarchy
**Permission Level:** Edit
**Use Cases:** Structure optimization, project reorganization

```typescript
move_page({
  pageId: "page-123",
  newParentId: "page-456", // Optional: root level if omitted
  position: 2 // Position within new parent
})
```

---

## Content Editing Tools

### replace_lines

**Purpose:** Replace specific lines in documents
**Permission Level:** Edit
**Use Cases:** Precise content updates, corrections

```typescript
replace_lines({
  pageId: "page-123",
  startLine: 5,
  endLine: 7, // Optional: defaults to startLine
  content: "Updated content for lines 5-7"
})
```

---

### insert_lines

**Purpose:** Insert content at specific line positions
**Permission Level:** Edit
**Use Cases:** Adding content mid-document, prepending, appending

```typescript
// Insert at specific line
insert_lines({
  pageId: "page-123",
  lineNumber: 10,
  content: "New content inserted at line 10"
})

// Prepend to beginning (line 1)
insert_lines({
  pageId: "page-123",
  lineNumber: 1,
  content: "# Executive Summary\nOverview content...\n\n"
})

// Append to end (use line count + 1)
insert_lines({
  pageId: "page-123",
  lineNumber: 101, // If document has 100 lines
  content: "\n\n## Additional Section\nNew content here..."
})
```

**Note:** Use `lineNumber: 1` for prepend, `lineNumber: lineCount + 1` for append

---

## Advanced Search & Discovery

### regex_search

**Purpose:** Pattern-based content search across workspace
**Permission Level:** Read
**Use Cases:** Finding specific patterns, code search, data extraction

```typescript
regex_search({
  pattern: "\\b\\d{4}-\\d{2}-\\d{2}\\b", // Date pattern
  driveId?: "drive-123", // Optional: limit to specific drive
  pageTypes?: ["DOCUMENT"], // Optional: filter page types
  caseSensitive?: false,
  maxResults?: 50
})
```

**Response:**
```json
{
  "success": true,
  "matches": [
    {
      "pageId": "page-123",
      "title": "Project Timeline",
      "path": "/projects/Project Timeline",
      "matchCount": 3,
      "snippets": [
        {
          "lineNumber": 15,
          "content": "Deadline: 2024-03-15",
          "matchText": "2024-03-15"
        }
      ]
    }
  ],
  "totalMatches": 12,
  "searchTime": 245
}
```

**Common Patterns:**
- Dates: `\\b\\d{4}-\\d{2}-\\d{2}\\b`
- Emails: `\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b`
- URLs: `https?://[^\\s]+`
- Phone Numbers: `\\b\\d{3}-\\d{3}-\\d{4}\\b`

---

### glob_search

**Purpose:** Structural discovery using glob patterns
**Permission Level:** Read
**Use Cases:** Finding files by name patterns, structural organization

```typescript
glob_search({
  pattern: "**/README*", // Find all README files
  driveId?: "drive-123",
  pageTypes?: ["DOCUMENT", "FOLDER"],
  maxResults?: 100
})
```

**Common Patterns:**
- All READMEs: `**/README*`
- Meeting notes: `**/meeting-*`
- Project folders: `**/project-*`
- Year-based content: `**/2024/**`

**Response:**
```json
{
  "success": true,
  "matches": [
    {
      "pageId": "page-456",
      "title": "README",
      "path": "/projects/alpha/README",
      "type": "DOCUMENT",
      "parentPath": "/projects/alpha"
    }
  ],
  "totalMatches": 5
}
```

---

### multi_drive_search

**Purpose:** Search across multiple drives simultaneously
**Permission Level:** Read (with automatic permission filtering)
**Use Cases:** Global content discovery, cross-project search

```typescript
multi_drive_search({
  query: "marketing campaign",
  searchType: "content", // "content", "title", "both"
  pageTypes?: ["DOCUMENT"],
  maxResultsPerDrive?: 10,
  includeSnippets?: true
})
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "driveId": "drive-123",
      "driveName": "Marketing",
      "matchCount": 8,
      "matches": [
        {
          "pageId": "page-789",
          "title": "Q1 Campaign Strategy",
          "path": "/marketing/Q1 Campaign Strategy",
          "snippet": "Our marketing campaign focuses on..."
        }
      ]
    }
  ],
  "totalMatches": 15,
  "searchedDrives": 3
}
```

---

## Task Management System

### create_task_list

**Purpose:** Create persistent task lists for complex operations
**Permission Level:** Write
**Use Cases:** Multi-step operations, project management, progress tracking

```typescript
create_task_list({
  title: "Website Redesign Project",
  description: "Complete website redesign with new branding",
  tasks: [
    {
      title: "Research competitor websites",
      description: "Analyze top 5 competitors",
      priority: "high",
      estimatedDuration: "2 hours"
    },
    {
      title: "Create wireframes",
      description: "Design key page layouts",
      priority: "medium",
      estimatedDuration: "4 hours"
    }
  ],
  dueDate?: "2024-03-15",
  assigneeId?: "user-123"
})
```

**Response:**
```json
{
  "success": true,
  "taskList": {
    "id": "tasklist-456",
    "title": "Website Redesign Project",
    "status": "active",
    "totalTasks": 2,
    "completedTasks": 0,
    "progress": 0,
    "tasks": [
      {
        "id": "task-789",
        "title": "Research competitor websites",
        "status": "pending",
        "priority": "high",
        "position": 1
      }
    ]
  }
}
```

---

### get_task_list

**Purpose:** Retrieve task list status and progress
**Permission Level:** Read
**Use Cases:** Progress monitoring, status updates

```typescript
get_task_list({
  taskListId: "tasklist-456"
})
```

---

### update_task_status

**Purpose:** Update individual task progress
**Permission Level:** Edit
**Use Cases:** Progress tracking, workflow management

```typescript
update_task_status({
  taskId: "task-789",
  status: "completed", // pending, in_progress, completed, blocked
  note?: "Completed analysis of 5 competitors",
  completedAt?: "2024-01-20T14:30:00Z"
})
```

---

### add_task

**Purpose:** Add new tasks to existing lists
**Permission Level:** Edit
**Use Cases:** Dynamic task expansion, discovered requirements

```typescript
add_task({
  taskListId: "tasklist-456",
  title: "User testing session",
  description: "Conduct usability testing with 5 users",
  priority: "medium",
  position?: 3, // Optional: specific position
  dependencies?: ["task-789"] // Optional: task dependencies
})
```

**Note:** To add notes or progress updates to tasks, use the `note` parameter in `update_task_status`.

---

### resume_task_list

**Purpose:** Resume task lists from previous sessions
**Permission Level:** Read
**Use Cases:** Cross-session continuity, project recovery

```typescript
resume_task_list({
  filters?: {
    status: "active",
    assigneeId: "user-123",
    priority: "high"
  },
  limit?: 5
})
```

---

## Agent Management

### list_agents

**Purpose:** Discover AI agents within specific drives
**Permission Level:** Read
**Use Cases:** Agent discovery, delegation planning

```typescript
list_agents({
  driveId: "drive-123",
  driveSlug: "marketing",
  includeSystemPrompt?: false,
  includeTools?: true
})
```

---

### multi_drive_list_agents

**Purpose:** Discover AI agents across all accessible drives
**Permission Level:** Read
**Use Cases:** Global agent discovery, cross-workspace collaboration

```typescript
multi_drive_list_agents({
  includeSystemPrompt?: false,
  includeTools?: true,
  groupByDrive?: true
})
```

**Response:**
```json
{
  "success": true,
  "totalCount": 8,
  "driveCount": 3,
  "agentsByDrive": [
    {
      "driveId": "drive-123",
      "driveName": "Marketing",
      "agentCount": 3,
      "agents": [
        {
          "id": "page-ai-123",
          "title": "Content Strategy AI",
          "path": "/marketing/Content Strategy AI",
          "enabledTools": ["create_page", "replace_lines", "insert_lines"],
          "aiProvider": "anthropic",
          "aiModel": "claude-3-5-sonnet-20241022",
          "hasConversationHistory": true
        }
      ]
    }
  ]
}
```

---

### ask_agent

**Purpose:** Consult other AI agents for specialized expertise
**Permission Level:** Read (to target agent)
**Use Cases:** Specialized consultation, agent collaboration

```typescript
ask_agent({
  agentPath: "/finance/Budget Analyst",
  agentId: "page-ai-456",
  question: "What's our Q4 budget status for marketing campaigns?",
  context?: "Preparing board presentation for next week"
})
```

**Response:**
```json
{
  "success": true,
  "agent": "Budget Analyst",
  "agentPath": "/finance/Budget Analyst",
  "question": "What's our Q4 budget status for marketing campaigns?",
  "response": "Based on current data, Q4 marketing budget shows 15% under target with $45,000 remaining across digital and traditional channels...",
  "context": "Preparing board presentation for next week",
  "metadata": {
    "agentId": "page-ai-456",
    "processingTime": 2340,
    "messagesInHistory": 23,
    "callDepth": 1,
    "provider": "Claude 3.5 Sonnet",
    "model": "claude-3-5-sonnet-20241022",
    "toolsEnabled": 5,
    "toolCalls": 2,
    "steps": 3
  }
}
```

---

### create_agent

**Purpose:** Create fully configured AI agents
**Permission Level:** Write
**Use Cases:** Specialized assistant creation, workflow automation

```typescript
create_agent({
  driveId: "drive-123",
  title: "Marketing Campaign AI",
  parentId?: "page-456",
  systemPrompt: "You are a marketing campaign specialist. Focus on data-driven insights and creative strategy...",
  enabledTools: [
    "create_page",
    "read_page",
    "replace_lines",
    "insert_lines",
    "create_task_list",
    "regex_search"
  ],
  aiProvider?: "anthropic",
  aiModel?: "claude-3-5-sonnet-20241022",
  description?: "AI assistant for marketing campaign planning and execution"
})
```

---

### update_agent_config

**Purpose:** Modify existing AI agent settings
**Permission Level:** Edit
**Use Cases:** Agent optimization, capability expansion

```typescript
update_agent_config({
  pageId: "page-ai-123",
  systemPrompt?: "Updated system prompt...",
  enabledTools?: ["create_page", "read_page", "ask_agent"],
  aiProvider?: "openai",
  aiModel?: "gpt-4o"
})
```

---

## Tool Permissions

### Role-Based Access

AI tools are filtered based on agent roles:

**PARTNER** (Full Capabilities):
- All read/write/delete operations
- Agent management
- Cross-workspace access

**PLANNER** (Read-Only Strategic):
- Read operations only
- Search and discovery tools
- Task list viewing (no modification)

**WRITER** (Execution-Focused):
- Content creation and editing
- Limited organizational operations
- No agent management

### Custom Tool Sets

Pages can define custom tool sets via `enabledTools` array:

```typescript
// Example: Content-focused agent
enabledTools: [
  "read_page",
  "create_page",
  "replace_lines",
  "insert_lines"
]

// Example: Analysis-focused agent
enabledTools: [
  "read_page",
  "regex_search",
  "glob_search",
  "multi_drive_search"
]

// Example: Project management agent
enabledTools: [
  "create_task_list",
  "update_task_status",
  "add_task",
  "ask_agent"
]
```

---

## Usage Examples

### 1. Complex Project Setup

```typescript
// Step 1: Create parent folder
const parentFolder = await create_page({
  driveId: "drive-123",
  title: "Q1 Campaign",
  type: "FOLDER"
});

// Step 2: Create sub-folders
await create_page({
  driveId: "drive-123",
  title: "Research",
  type: "FOLDER",
  parentId: parentFolder.id
});

await create_page({
  driveId: "drive-123",
  title: "Creative Assets",
  type: "FOLDER",
  parentId: parentFolder.id
});

// Step 3: Create Campaign AI agent
await create_page({
  driveId: "drive-123",
  title: "Campaign AI",
  type: "AI_CHAT",
  systemPrompt: "Marketing campaign specialist...",
  enabledTools: ["create_page", "replace_lines", "insert_lines", "create_task_list"],
  parentId: parentFolder.id
});

// Step 4: Create task list for campaign
await create_task_list({
  title: "Q1 Campaign Launch",
  tasks: [
    { title: "Market research", priority: "high" },
    { title: "Creative development", priority: "medium" },
    { title: "Campaign execution", priority: "high" }
  ]
});
```

### 2. Content Standardization

```typescript
// Step 1: Find all documents needing updates
const searchResults = await regex_search({
  pattern: "\\[OLD_FORMAT\\]",
  pageTypes: ["DOCUMENT"]
});

// Step 2: Update each document individually
for (const match of searchResults.matches) {
  // Read current content
  const page = await read_page({ pageId: match.pageId });

  // Replace old format with new
  const updatedContent = page.content.replace(/\[OLD_FORMAT\]/g, "[UPDATED_FORMAT]");

  // Update the page
  await replace_lines({
    pageId: match.pageId,
    startLine: 1,
    endLine: page.lineCount,
    content: updatedContent
  });

  // Rename with new convention
  await rename_page({
    pageId: match.pageId,
    title: `[2024] ${page.title}`
  });
}
```

### 3. Cross-Agent Collaboration

```typescript
// Step 1: Discover relevant agents
const agents = await multi_drive_list_agents({
  groupByDrive: true
});

// Step 2: Consult finance agent for budget
const budgetInfo = await ask_agent({
  agentPath: "/finance/Budget AI",
  agentId: "agent-finance-123",
  question: "What's available budget for Q1 marketing?",
  context: "Planning new campaign launch"
});

// Step 3: Consult legal agent for compliance
const legalReview = await ask_agent({
  agentPath: "/legal/Compliance AI",
  agentId: "agent-legal-456",
  question: "Any compliance concerns for social media campaign in EU?",
  context: "Q1 campaign includes European market expansion"
});

// Step 4: Create comprehensive campaign plan
await create_page({
  driveId: "marketing-drive",
  title: "Q1 Campaign Plan",
  type: "DOCUMENT",
  content: `# Q1 Campaign Plan

## Budget Analysis
${budgetInfo.response}

## Legal Considerations
${legalReview.response}

## Next Steps
...`
});
```

### 4. Maintenance Operations

```typescript
// Step 1: Find outdated content
const outdatedContent = await regex_search({
  pattern: "2023",
  pageTypes: ["DOCUMENT"]
});

// Step 2: Create task list for updates
await create_task_list({
  title: "Content Maintenance - 2024 Updates",
  tasks: outdatedContent.matches.map(match => ({
    title: `Update ${match.title}`,
    description: `Update dates and references in ${match.path}`
  }))
});

// Step 3: Archive old files individually
const oldFiles = await glob_search({
  pattern: "**/archive/**"
});

for (const file of oldFiles.matches) {
  await move_page({
    pageId: file.pageId,
    newParentId: "archive-folder-id"
  });
}
```

## Best Practices

### 1. Always Start with Discovery
Begin operations with `list_pages` to understand structure before making changes.

### 2. Read Before Writing
Always use `read_page` before editing to get current content and line counts.

### 3. Implement Error Handling
Check tool responses for errors and implement retry logic for critical operations.

### 4. Leverage Agent Specialization
Use `ask_agent` to delegate specialized tasks to domain-specific AI assistants.

### 5. Maintain Audit Trails
All tool operations are automatically logged; use task lists for complex multi-step operations.

### 6. Respect Permissions
Tools automatically enforce user permissions; ensure proper access before operations.

### 7. Optimize for Performance
Use search tools to filter and target operations rather than reading all content.

This comprehensive tool set enables AI assistants to perform sophisticated workspace automation while maintaining security, permissions, and data consistency across the entire PageSpace platform.
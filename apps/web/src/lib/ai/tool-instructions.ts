/**
 * Comprehensive Tool Usage Instructions for PageSpace AI
 *
 * These instructions teach the AI how to effectively use all available tools,
 * including when to use each tool, how to chain them, and best practices.
 */

export interface ToolInstructionSection {
  category: string;
  priority: number;
  instructions: string;
  examples: string[];
  errorPatterns: string[];
}

export const TOOL_INSTRUCTIONS: Record<string, ToolInstructionSection> = {
  // ==========================================
  // WORKSPACE NAVIGATION
  // ==========================================
  workspace_navigation: {
    category: 'Core Navigation',
    priority: 1,
    instructions: `
# WORKSPACE NAVIGATION PATTERN

You operate in a hierarchical workspace system: Workspaces (Drives) → Folders → Documents/Pages

## CRITICAL WORKFLOW - Always follow this sequence:
1. **Discovery**: list_drives → Find available workspaces
2. **Exploration**: list_pages(driveId, driveSlug) → Map workspace structure
3. **Reading**: read_page(pageId, path) → Access specific content
4. **Action**: Use appropriate write/organize tools

## DUAL PARAMETER SYSTEM:
- **driveSlug**: Human-readable identifier for semantic understanding (e.g., "marketing", "personal")
- **driveId**: Unique system ID for operations (e.g., "clq2n3...")
- **ALWAYS provide both** when available for clarity and reliability

## PERMISSION AWARENESS:
- You can only see/edit pages you have permission for
- If access denied, check parent folder or suggest alternatives
- Drive owners have full access, members have limited access`,

    examples: [
      `User: "What's in my marketing workspace?"
      → list_drives() to find "marketing" drive
      → list_pages(driveId="clq2n3...", driveSlug="marketing")
      → Present hierarchical structure with emojis`,

      `User: "Show me all my project documents"
      → list_drives() in parallel for all workspaces
      → list_pages() for each drive (parallel execution)
      → Filter for document types (📄)`,
    ],

    errorPatterns: [
      'ERROR: "You don\'t have access to this drive" → Suggest: Check drive membership, try parent workspace',
      'ERROR: "Page not found" → Use search_pages or glob_search to locate',
      'ERROR: "Insufficient permissions" → Explain limitation, suggest contacting workspace owner',
    ],
  },

  // ==========================================
  // DOCUMENT OPERATIONS
  // ==========================================
  document_operations: {
    category: 'Content Management',
    priority: 2,
    instructions: `
# DOCUMENT OPERATIONS - The Right Tool for Every Edit

## GOLDEN RULE: ALWAYS READ BEFORE WRITE
**NEVER** modify content without first reading it. This is non-negotiable.

## TOOL SELECTION MATRIX:

### LINE-BASED EDITING (Precision Operations):
- **replace_lines**: Surgical edits to specific lines (1-based indexing)
  - Use when: Updating specific sections, fixing errors, replacing paragraphs
  - Example: replace_lines(startLine=5, endLine=7, content="new content")

- **insert_lines**: Add content at exact positions
  - Use when: Adding new sections, inserting between existing content
  - Example: insert_lines(lineNumber=10, content="inserted text")

### BULK OPERATIONS (Speed & Convenience):
- **append_to_page**: Add to end of document
  - Use when: Adding notes, logs, new sections at end
  - Faster than reading line count + insert_lines

- **prepend_to_page**: Add to beginning
  - Use when: Adding headers, summaries, timestamps

- **create_page**: Start fresh documents
  - Use when: New content, specific page types needed
  - Supports: DOCUMENT, FOLDER, AI_CHAT, CHANNEL, CANVAS

## FILE TYPE AWARENESS:
- **FILE pages are READ-ONLY** - These are uploads (PDFs, images, etc.)
- To "edit" a FILE: Create a new DOCUMENT page with modifications
- Visual files require vision-capable models to process

## ATOMIC OPERATIONS:
For complex changes, use batch_page_operations for all-or-nothing execution`,

    examples: [
      `User: "Add a summary to the top of my report"
      → read_page(pageId, path) - Get current content
      → prepend_to_page(pageId, "## Executive Summary\\n...")`,

      `User: "Fix the typo on line 15"
      → read_page(pageId, path) - Verify content
      → replace_lines(pageId, startLine=15, endLine=15, "corrected text")`,

      `User: "Create a project structure"
      → batch_page_operations([
          {type: "create", tempId: "t1", title: "Project Alpha", pageType: "FOLDER"},
          {type: "create", tempId: "t2", title: "README", pageType: "DOCUMENT", parentId: "t1"},
          {type: "create", tempId: "t3", title: "Tasks", pageType: "DOCUMENT", parentId: "t1"}
        ])`,
    ],

    errorPatterns: [
      'ERROR: "Cannot edit FILE pages" → Create new DOCUMENT with modifications',
      'ERROR: "Invalid line range" → Re-read page, check line count',
      'ERROR: "Page is being processed" → Wait and retry for uploaded files',
    ],
  },

  // ==========================================
  // SEARCH STRATEGIES
  // ==========================================
  search_strategies: {
    category: 'Discovery & Search',
    priority: 3,
    instructions: `
# SEARCH STRATEGIES - Find Anything, Fast

## SEARCH TOOL HIERARCHY:

### 1. web_search - EXTERNAL WEB SEARCH (Current Information!)
- **Purpose**: Search the web for current information, news, documentation, and real-time data
- **Use when**:
  - User asks about current events, news, or recent developments
  - Information needed is time-sensitive or outside your knowledge cutoff
  - User wants to research a topic with up-to-date web sources
  - Looking for documentation, guides, or resources that may have been updated
  - Verifying facts or finding authoritative sources
- **Features**:
  - Returns structured results with titles, URLs, summaries, and publication dates
  - Supports domain filtering (e.g., "docs.python.org")
  - Supports recency filtering ("oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit")
  - Provides citation references (e.g., [ref_1])
- **Best for**: Real-time information, current documentation, news, fact-checking

### 2. glob_search - STRUCTURAL DISCOVERY (PageSpace Content)
- **Purpose**: Find pages by name/path patterns within PageSpace
- **Patterns**:
  - "**/README*" - All READMEs in any location
  - "project-*" - All projects at current level
  - "*/meeting-notes/*" - Meeting notes in any folder
- **Best for**: Finding files by naming conventions in PageSpace

### 3. regex_search - CONTENT PATTERNS (PageSpace Content)
- **Purpose**: Search inside document content within PageSpace
- **Patterns**:
  - "TODO.*urgent" - Urgent todos
  - "\\d{4}-\\d{2}-\\d{2}" - Dates (YYYY-MM-DD)
  - "function\\s+\\w+\\(" - Function definitions
- **Options**: Search in content, title, or both
- **Returns**: Matching lines with line numbers

### 4. search_pages - FUZZY TEXT SEARCH (PageSpace Content)
- **Purpose**: Natural language search across pages in PageSpace
- **Best for**: Finding topics, concepts, general content
- **Example**: "authentication flow", "meeting notes from January"

### 5. multi_drive_search - CROSS-WORKSPACE (PageSpace Content)
- **Purpose**: Search across multiple workspaces simultaneously in PageSpace
- **Use when**: Don't know which workspace contains info
- **Parallel execution**: Search all drives at once

## SEARCH WORKFLOW:
1. **External information**: Use web_search for current events, news, documentation, or real-time data
2. **Internal structure**: Start with glob_search for PageSpace page structure
3. **Internal content**: Use regex_search for specific patterns in PageSpace
4. **Conceptual search**: Use search_pages for natural language queries in PageSpace
5. **Cross-workspace**: Fall back to multi_drive_search if location unknown in PageSpace

## PARALLEL SEARCH PATTERN:
Execute multiple searches simultaneously:
- Different patterns in same drive
- Same pattern across drives
- Multiple search types together`,

    examples: [
      `User: "What are the latest developments in AI safety?"
      → web_search(query="latest developments in AI safety 2025", count=10, recencyFilter="oneMonth")
      → Synthesize key findings with citations`,

      `User: "Find the official React Server Components documentation"
      → web_search(query="React Server Components documentation", domainFilter="react.dev", count=5)
      → Provide summary with authoritative links`,

      `User: "Find all TODO items"
      → regex_search(pattern="TODO", searchIn="content")
      → Group results by page and priority`,

      `User: "Where are my Python files?"
      → glob_search(pattern="**/*.py")
      → List with full paths`,

      `User: "Find discussions about pricing"
      → search_pages(query="pricing discussion")
      → Read top matches for context`,

      `User: "Find all meeting notes from this month"
      PARALLEL:
      → glob_search(pattern="**/meeting*")
      → regex_search(pattern="2024-01", searchIn="content")
      → search_pages(query="meeting January 2024")`,
    ],

    errorPatterns: [
      'ERROR: "Invalid regex pattern" → Escape special characters for PostgreSQL',
      'ERROR: "No matches found" → Broaden pattern, try different search tool',
      'ERROR: "Search timeout" → Reduce maxResults, narrow search scope',
    ],
  },

  // ==========================================
  // TASK MANAGEMENT
  // ==========================================
  task_management: {
    category: 'Progress Tracking',
    priority: 4,
    instructions: `
# TASK MANAGEMENT - Track Complex Operations

## WHEN TO USE TASK LISTS:
- Multi-step operations (3+ steps)
- Operations spanning multiple pages
- Work that needs progress tracking
- Complex reorganizations
- Long-running processes

## TASK LIST WORKFLOW:
1. **create_task_list**: Initialize with all planned tasks
2. **update_task_status**: Mark as in_progress when starting
3. **update_task_status**: Mark as completed when done
4. **add_task**: Add new tasks discovered during work
5. **get_task_list**: Review current progress

## TASK PRIORITIES:
- **high**: Blocking other work, urgent
- **medium**: Normal workflow (default)
- **low**: Nice-to-have, can be deferred

## BEST PRACTICES:
- Create granular, actionable tasks
- Update status immediately after completion
- Add time estimates for planning
- Link tasks to specific pages/drives
- Use task notes for important context

## PERSISTENCE:
Task lists persist across AI conversations - great for long-term projects`,

    examples: [
      `User: "Reorganize my documentation"
      → create_task_list(
          title="Documentation Reorganization",
          tasks=[
            {title: "Audit current structure", priority: "high"},
            {title: "Create new folder hierarchy", priority: "high"},
            {title: "Move API docs", priority: "medium"},
            {title: "Update README links", priority: "medium"},
            {title: "Archive old docs", priority: "low"}
          ]
        )
      → update_task_status as each completes`,

      `User: "What's left on my task list?"
      → get_task_list()
      → Show pending/in_progress tasks
      → Calculate completion percentage`,
    ],

    errorPatterns: [
      'ERROR: "Task not found" → Use get_task_list to see current tasks',
      'ERROR: "Invalid status transition" → Can\'t move completed back to pending',
      'ERROR: "Parent task not found" → Ensure taskListId is correct',
    ],
  },

  // ==========================================
  // BULK OPERATIONS
  // ==========================================
  bulk_operations: {
    category: 'Simple Bulk Operations',
    priority: 5,
    instructions: `
# BULK OPERATIONS - Simple and Atomic

## PURPOSE:
Execute single-purpose operations on multiple pages atomically.
Each tool has a clear, specific purpose - no confusion about when to use what.

## AVAILABLE TOOLS:
- **create_folder_structure**: Create hierarchical structures (folders, docs, chats)
- **bulk_move_pages**: Move multiple pages to new location
- **bulk_rename_pages**: Rename multiple pages with patterns
- **bulk_delete_pages**: Delete multiple pages (with/without children)
- **bulk_update_content**: Update content in multiple pages

## KEY BENEFITS:
- **No tempId confusion** - eliminated entirely
- **Single purpose per tool** - crystal clear usage
- **Atomic execution** - all succeed or all fail
- **Simple error handling** - easier to debug
- **Better AI compatibility** - obvious tool selection

## WHEN TO USE WHICH TOOL:
- **Need hierarchical structure?** → create_folder_structure
- **Need to move pages?** → bulk_move_pages
- **Need to rename pages?** → bulk_rename_pages
- **Need to delete pages?** → bulk_delete_pages
- **Need to update content?** → bulk_update_content

## STRUCTURE PATTERNS:
For hierarchical creation, define nested objects with title, type, content, and children.
For bulk operations, provide arrays of page IDs and operation parameters.`,

    examples: [
      `User: "Create a new project structure"
      → create_folder_structure({
          structure: [
            {title: "New Project", type: "FOLDER", children: [
              {title: "Documentation", type: "FOLDER", children: [
                {title: "README", type: "DOCUMENT", content: "# Project Name"}
              ]},
              {title: "Source", type: "FOLDER"},
              {title: "AI Assistant", type: "AI_CHAT"}
            ]}
          ]
        })`,

      `User: "Move these files to archive folder"
      → bulk_move_pages({
          pageIds: ["page1", "page2", "page3"],
          targetParentId: "archiveFolder",
          targetDriveId: "drive123"
        })`,

      `User: "Rename all docs to have 'v2' prefix"
      → bulk_rename_pages({
          pageIds: ["doc1", "doc2", "doc3"],
          renamePattern: {type: "prefix", prefix: "v2 "}
        })`,
    ],

    errorPatterns: [
      'ERROR: "No permission to move page X" → Check individual page permissions',
      'ERROR: "Page not found" → Verify page IDs are correct',
      'ERROR: "Pattern requires X field" → Check required fields for rename pattern type',
    ],
  },

  // ==========================================
  // AI AGENT MANAGEMENT
  // ==========================================
  agent_management: {
    category: 'AI Configuration',
    priority: 6,
    instructions: `
# AI AGENT MANAGEMENT - Create Specialized Assistants

## AGENT CREATION:
Use create_agent to build specialized AI assistants with:
- Custom system prompts
- Specific tool sets
- Dedicated AI models
- Contextual placement in workspace

## TOOL ENABLEMENT:
Choose tools based on agent purpose:
- **Research Agents**: All read tools + search tools
- **Writing Agents**: Page write tools + create tools
- **Organizer Agents**: Batch operations + move/rename tools
- **Project Managers**: Task management + read tools
- **Chat-Only Agents**: No tools (empty array)

## SYSTEM PROMPT DESIGN:
Structure agent prompts with:
1. Role definition
2. Expertise areas
3. Behavioral guidelines
4. Tool usage instructions
5. Output format preferences

## AGENT PLACEMENT:
- Root level: Workspace-wide assistants
- In folders: Context-specific helpers
- In documents: Page-specific support

## MODEL SELECTION:
- Override defaults for specialized needs
- Vision models for image processing
- Fast models for simple tasks
- Powerful models for complex reasoning`,

    examples: [
      `User: "Create a code review assistant"
      → create_agent(
          title="Code Reviewer",
          systemPrompt="You are an expert code reviewer. Focus on: clean code, performance, security, best practices...",
          enabledTools=["read_page", "regex_search", "create_task_list", "append_to_page"],
          aiModel="gpt-4"
        )`,

      `User: "Set up a project manager AI"
      → create_agent(
          title="Project Manager",
          systemPrompt="You manage projects efficiently. Track tasks, organize documents, maintain timelines...",
          enabledTools=["create_task_list", "update_task_status", "batch_page_operations", "list_pages"],
          parentId="projectFolder"
        )`,
    ],

    errorPatterns: [
      'ERROR: "Invalid tool name" → Check available tools list',
      'ERROR: "Cannot create at root" → Only drive owners can create root agents',
      'ERROR: "Model not available" → Check supported models for provider',
    ],
  },

  // ==========================================
  // PARALLEL EXECUTION
  // ==========================================
  parallel_execution: {
    category: 'Performance Optimization',
    priority: 7,
    instructions: `
# PARALLEL EXECUTION - Maximum Efficiency

## CRITICAL RULE: PARALLELIZE WHENEVER POSSIBLE
Don't wait for one operation to complete before starting another unless output of A is required for input of B.

## PARALLEL PATTERNS:

### READING MULTIPLE PAGES:
PARALLEL:
→ read_page(id1, path1)
→ read_page(id2, path2)
→ read_page(id3, path3)
NOT sequential!

### SEARCHING DIFFERENT PATTERNS:
PARALLEL:
→ glob_search("**/*.md")
→ regex_search("TODO")
→ search_pages("important")

### EXPLORING MULTIPLE WORKSPACES:
PARALLEL:
→ list_pages(drive1)
→ list_pages(drive2)
→ list_pages(drive3)

### CREATING INDEPENDENT CONTENT:
PARALLEL:
→ create_page(page1)
→ create_page(page2)
→ create_page(page3)

## WHEN TO STAY SEQUENTIAL:
- Creating parent before child
- Reading before editing
- Searching before reading results
- Checking permissions before operations

## PERFORMANCE GAINS:
- 3-5x faster execution
- Better user experience
- Reduced latency
- Efficient resource usage

## LIMITS:
- Max 5 parallel operations at once
- Batch similar operations together
- Group by operation type when possible`,

    examples: [
      `User: "Summarize my three reports"
      PARALLEL:
      → read_page("report1")
      → read_page("report2")
      → read_page("report3")
      Then synthesize results`,

      `User: "Find all documentation"
      PARALLEL:
      → glob_search("**/README*")
      → glob_search("**/docs/*")
      → search_pages("documentation")
      → search_pages("guide")`,
    ],

    errorPatterns: [
      'ERROR: "Rate limit exceeded" → Reduce parallel operations to 3',
      'ERROR: "Timeout" → Break into smaller batches',
      'ERROR: "Dependency error" → Check operation order',
    ],
  },

  // ==========================================
  // ERROR RECOVERY
  // ==========================================
  error_recovery: {
    category: 'Resilience Patterns',
    priority: 8,
    instructions: `
# ERROR RECOVERY - Graceful Failure Handling

## PERMISSION ERRORS:
- "Insufficient permissions" → Check parent folder access
- "Cannot edit" → Verify you have EDIT not just VIEW access
- "Access denied" → Suggest contacting workspace owner
- Alternative: Work in a different location

## NOT FOUND ERRORS:
- "Page not found" → Use search tools to locate
- "Drive not found" → Run list_drives to see available
- "Parent not found" → Verify parentId exists
- Recovery: Create missing structure

## PROCESSING ERRORS:
- "File being processed" → Wait 2-3 seconds and retry
- "Visual content requires vision" → Switch to vision model
- "Content too large" → Use pagination or chunks
- Recovery: Read in sections

## OPERATION FAILURES:
- "Transaction rolled back" → Check individual operations
- "Invalid line number" → Re-read to get current line count
- "Circular reference" → Review hierarchy before moving
- Recovery: Break into smaller operations

## RETRY STRATEGY:
1. First failure: Wait 1 second, retry
2. Second failure: Check prerequisites, adjust parameters
3. Third failure: Explain limitation to user, suggest alternatives

## FALLBACK PATTERNS:
- Can't edit? → Create new version
- Can't move? → Copy and delete
- Can't search? → Manual exploration
- Can't batch? → Individual operations`,

    examples: [
      `ERROR: "Cannot access drive"
      → list_drives() to see available
      → Suggest: "You don't have access to that workspace. Here are your available workspaces..."`,

      `ERROR: "Page processing"
      → Wait 2 seconds
      → Retry read_page()
      → If still processing: "File is being processed, please try again in a moment"`,

      `ERROR: "Line 50 doesn't exist"
      → read_page() to check current content
      → Adjust line numbers based on actual content
      → Retry operation`,
    ],

    errorPatterns: [
      'PATTERN: Permission cascade → Check parent, grandparent, drive access',
      'PATTERN: Not found cascade → Search locally, then globally',
      'PATTERN: Processing cascade → Wait, retry, explain delay',
    ],
  },
};

/**
 * Get prioritized tool instructions for system prompt
 */
export function getToolInstructions(
  includeCategories?: string[],
  maxPriority?: number
): string {
  const sections = Object.values(TOOL_INSTRUCTIONS)
    .filter(section => {
      if (includeCategories && !includeCategories.includes(section.category)) {
        return false;
      }
      if (maxPriority && section.priority > maxPriority) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.priority - b.priority);

  return sections
    .map(section => {
      const exampleText = section.examples.length > 0
        ? `\n\n## Examples:\n${section.examples.join('\n\n')}`
        : '';

      const errorText = section.errorPatterns.length > 0
        ? `\n\n## Error Handling:\n${section.errorPatterns.join('\n')}`
        : '';

      return `${section.instructions}${exampleText}${errorText}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Get tool instructions for a specific role
 */
export function getRoleSpecificInstructions(role: 'PARTNER' | 'PLANNER' | 'WRITER'): string {
  switch (role) {
    case 'PARTNER':
      return getToolInstructions([
        'Core Navigation',
        'Content Management',
        'Discovery & Search',
        'Progress Tracking',
        'Performance Optimization',
        'Resilience Patterns',
      ]);

    case 'PLANNER':
      return getToolInstructions([
        'Core Navigation',
        'Discovery & Search',
        'Progress Tracking',
        'AI Configuration',
      ], 5); // Exclude write operations

    case 'WRITER':
      return getToolInstructions([
        'Core Navigation',
        'Content Management',
        'Simple Bulk Operations',
        'Performance Optimization',
      ]);

    default:
      return getToolInstructions();
  }
}
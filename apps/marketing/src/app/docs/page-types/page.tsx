import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Page Types",
  description: "Technical reference for all 9 page types in PageSpace: documents, folders, AI chats, channels, canvases, sheets, task lists, code files, and uploaded files.",
  path: "/docs/page-types",
  keywords: ["page types", "documents", "channels", "AI chat", "canvas", "sheets", "tasks", "code editor"],
});

const content = `
# Page Types

Everything in PageSpace is a **page**. Pages are the universal content primitive — they form a recursive tree, inherit permissions from their drive, and participate in search, mentions, and AI context.

There are 9 page types, each designed for a different kind of work.

## DOCUMENT

Rich text documents powered by TipTap with full markdown support.

| Feature | Detail |
|---------|--------|
| Editor | TipTap with markdown shortcuts |
| Real-time | Yes — live collaboration via Socket.IO |
| Versioning | Yes |
| AI | Inline assistance, slash commands |
| Uploads | Drag-and-drop file attachments |

Documents support headings, lists, code blocks, tables, blockquotes, and embedded files. Content is stored as HTML with markdown import/export.

## FOLDER

Organizational containers for grouping pages.

| Feature | Detail |
|---------|--------|
| Nesting | Unlimited depth |
| Uploads | Drag-and-drop — files become child FILE pages |
| Sorting | Manual drag-and-drop reordering |

Folders are semantic — moving a page into a different folder changes its context for AI and permissions. The tree structure encodes meaning.

## AI_CHAT

Dedicated AI conversation pages with full tool calling support.

| Feature | Detail |
|---------|--------|
| Providers | 7 providers, 100+ models |
| Tools | 13+ workspace automation tools |
| Roles | PARTNER, PLANNER, WRITER |
| Multi-user | Multiple people can chat with the same AI |
| Context | Inherits context from parent pages |

Each AI_CHAT page can be configured with a custom system prompt, specific enabled tools, and a preferred AI provider/model. The agent understands its position in the workspace hierarchy.

\`\`\`typescript
// Create an AI agent via the API
POST /api/pages
{
  "driveId": "drive-123",
  "title": "Research Assistant",
  "type": "AI_CHAT",
  "parentId": "folder-456"
}

// Then configure it
PATCH /api/pages/{pageId}/agent-config
{
  "systemPrompt": "You are a research assistant...",
  "enabledTools": ["read_page", "regex_search", "multi_drive_search"],
  "aiProvider": "anthropic",
  "aiModel": "claude-sonnet-4-20250514"
}
\`\`\`

## CHANNEL

Real-time team messaging pages.

| Feature | Detail |
|---------|--------|
| Real-time | Yes — instant message delivery via Socket.IO |
| AI | @mention AI agents in conversations |
| Threads | Threaded replies |
| Uploads | Inline file sharing |

Channels function like Slack channels but live inside your workspace tree. You can @mention any AI agent to bring it into the conversation.

## CANVAS

Custom HTML and CSS pages rendered in an isolated Shadow DOM.

| Feature | Detail |
|---------|--------|
| Rendering | Shadow DOM isolation |
| Editor | Code editor for HTML/CSS |
| Versioning | Yes |
| Navigation | Functional links between pages |

Canvases are for building dashboards, landing pages, widgets, and visual tools. The Shadow DOM ensures your custom styles don't leak into the PageSpace UI.

## FILE

Uploaded files with automatic processing.

| Feature | Detail |
|---------|--------|
| Max size | 100 MB |
| Processing | Automatic text extraction, image optimization |
| Storage | Content-addressed deduplication |
| Convert | Files can be converted to DOCUMENT pages |

Files are processed by the dedicated processor service. Images are optimized, text is extracted from documents, and metadata is stored in PostgreSQL. Content-addressed storage means identical files are stored only once.

## SHEET

Spreadsheets with formula support and AI assistance.

| Feature | Detail |
|---------|--------|
| Real-time | Yes — live cell collaboration |
| Formulas | Standard spreadsheet formulas |
| AI | AI can analyze data and generate formulas |
| Versioning | Yes |

Sheets support standard spreadsheet operations with real-time collaboration. AI agents can read sheet data and help with analysis.

## TASK_LIST

Project management with structured task tracking.

| Feature | Detail |
|---------|--------|
| Views | Table view, kanban board |
| Fields | Status, priority, assignee, due date |
| AI | AI can create and update tasks via \`update_task\` tool |
| Real-time | Yes — live status updates |
| Linked pages | Each task creates a linked DOCUMENT for notes |

Task lists are first-class AI citizens — agents can create task lists, add tasks, update status, and track progress programmatically.

\`\`\`typescript
// AI tool: Create a task on a task list page
update_task({
  pageId: "tasklist-page-123",
  title: "Review competitor analysis",
  priority: "high",
  status: "pending"
})
\`\`\`

## CODE

Monaco-powered code editor with syntax highlighting.

| Feature | Detail |
|---------|--------|
| Editor | Monaco (VS Code engine) |
| Languages | 50+ languages with syntax highlighting |
| Real-time | Yes — live collaboration |
| Versioning | Yes |

Code pages use the same editor engine as VS Code, providing familiar editing experience with syntax highlighting, auto-indentation, and bracket matching.

## Page Hierarchy

All page types compose into a single recursive tree:

\`\`\`
📁 Project/                    (FOLDER)
├── 📄 Requirements            (DOCUMENT)
├── 📋 Sprint Board            (TASK_LIST)
├── 💬 Team Chat               (CHANNEL)
├── 🤖 Project AI              (AI_CHAT)
├── 📊 Budget                  (SHEET)
├── 🎨 Dashboard               (CANVAS)
├── 💻 config.json             (CODE)
└── 📁 Assets/                 (FOLDER)
    ├── 📎 logo.png            (FILE)
    └── 📎 brief.pdf           (FILE)
\`\`\`

This recursive composition means any page type can be a child of any folder. The tree structure drives permissions, AI context, and navigation.
`;

export default function PageTypesPage() {
  return <DocsMarkdown content={content} />;
}

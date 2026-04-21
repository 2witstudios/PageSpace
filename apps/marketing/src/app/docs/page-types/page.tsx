import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Page Types",
  description: "Reference for the 9 built-in page types: documents, folders, AI chats, channels, canvases, sheets, task lists, code files, and uploaded files.",
  path: "/docs/page-types",
  keywords: ["page types", "documents", "channels", "AI chat", "canvas", "sheets", "tasks", "code editor"],
});

const content = `
# Page Types

Everything in PageSpace is a **page**. Pages are the universal content primitive — they form a recursive tree, inherit permissions from their drive, and participate in search, mentions, and AI context.

There are 9 built-in page types, each designed for a different kind of work. A tenth type — \`TERMINAL\` — ships as experimental and is hidden from the create menu.

## DOCUMENT

Rich text documents powered by TipTap with full markdown support.

| Feature | Detail |
|---------|--------|
| Editor | TipTap with markdown input shortcuts |
| Real-time | Yes — live collaboration via Socket.IO |
| Versioning | Yes |
| Formatting UI | Bubble toolbar on selection, \`/\` floating menu for blocks |
| Uploads | Drag-and-drop file attachments |

To bring AI into a document, @mention an AI_CHAT page or ask an agent from a sibling page to read and edit it via \`read_page\` / \`replace_lines\`.

Documents support headings, lists, code blocks, tables, blockquotes, and embedded files. Each page stores its content in one of two modes — HTML (default) or Markdown.

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
| Providers | 12 providers wired through the Vercel AI SDK |
| Tools | 38 workspace tools, covering page reads and writes, search, tasks, calendar, channels, and agent coordination |
| Modes | \`isReadOnly\` toggle (explore-only) and \`webSearchEnabled\` toggle (enables \`web_search\`) |
| Multi-user | Multiple people can chat with the same AI |
| Context | System prompt includes drive, breadcrumb path, and page type |

Each AI_CHAT page can be configured with a custom system prompt, a subset of the 38 tools, and a preferred provider/model. The agent's system prompt is populated with its location in the tree so it knows where in the workspace it's operating.

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
  "aiModel": "claude-sonnet-4-6-20260217"
}
\`\`\`

## CHANNEL

Real-time team messaging pages.

| Feature | Detail |
|---------|--------|
| Real-time | Yes — instant message delivery via Socket.IO |
| AI | @mention AI agents in conversations |
| Reactions | Emoji reactions on messages |
| Uploads | Inline file attachments per message |

Channels function like team chat but live inside your workspace tree. @mention any AI agent to pull it into the conversation; AI-posted messages carry sender metadata so it's clear who spoke.

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
| Max size | 20 MB by default (configurable per deployment) |
| Processing | Image optimization, OCR, and text extraction run in the background after upload |
| Storage | Content-addressed — identical bytes are stored once regardless of how many places reference them |
| Convert | Files can be converted to DOCUMENT pages |

Files are processed by the dedicated processor service. Images are optimized, OCR runs on scanned content, text is extracted from documents, and metadata is stored in PostgreSQL. Content-addressed storage means identical bytes are stored once regardless of how many places they're linked from.

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
| Views | Table view and kanban board (toggled in the header) |
| Fields | Title, priority (\`low\`/\`medium\`/\`high\`), due date, and multiple assignees (users or AI agents) |
| Custom statuses | Each list defines its own status set — name, color, and group (\`todo\` / \`in_progress\` / \`done\`) |
| AI | Agents create and update tasks via \`update_task\` and pick up assigned work via \`get_assigned_tasks\` |
| Real-time | Yes — live status updates |
| Linked pages | Page-based tasks can have an optional linked DOCUMENT for notes |

Task lists are first-class AI citizens — agents can add tasks, change status, and work through a list of assignments that were routed to them.

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
| Languages | Every language Monaco ships by default (JS, TS, Python, Rust, Go, SQL, Markdown, and so on) |
| Real-time | Yes — live collaboration via Socket.IO |
| Versioning | Yes |

Code pages use the same editor engine as VS Code, giving you syntax highlighting, auto-indentation, and bracket matching.

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

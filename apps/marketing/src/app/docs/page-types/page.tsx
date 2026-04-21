import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Page Types",
  description: "The 9 built-in page types in PageSpace: documents, folders, AI chats, channels, canvases, sheets, task lists, code files, and uploaded files.",
  path: "/docs/page-types",
  keywords: ["page types", "documents", "channels", "AI chat", "canvas", "sheets", "tasks", "code editor"],
});

const content = `
# Page Types

Everything in PageSpace is a **page** — the universal container that forms a recursive tree, inherits permissions from its drive, and participates in search, @mentions, and AI context. For what you do with any page regardless of its type, see [Pages](/docs/how-it-works/pages).

There are **9 built-in page types**, each tuned for a different kind of work. Every type behaves like a page — you move it, share it, link to it, export it, trash it — so the differences below are about what you can put *in* each one.

## The 9 types

- **Document** — Rich-text pages with markdown input, real-time collaboration, and version history. The everyday content page. [Read more →](/docs/how-it-works/documents)
- **Folder** — Containers that hold other pages. No editor, no content of their own — they exist to organise. [Read more →](/docs/how-it-works/folders)
- **AI Chat** — A conversation with an AI agent that can read, write, and organise your workspace using real tools. [Read more →](/docs/how-it-works/ai)
- **Channel** — Real-time team messaging that lives in the page tree. @-mention an AI agent and it joins the conversation. [Read more →](/docs/how-it-works/channels)
- **Canvas** — Custom HTML and CSS rendered in an isolated Shadow DOM — for dashboards, landing pages, and visual widgets. [Read more →](/docs/how-it-works/canvas)
- **File** — Uploaded files with background text extraction, OCR, and image optimisation. Identical uploads are stored once. [Read more →](/docs/how-it-works/files)
- **Sheet** — Spreadsheets with formulas, real-time cell collaboration, and AI that can read and analyse data. [Read more →](/docs/how-it-works/sheets)
- **Task List** — Structured work with a table and kanban view, custom statuses, and assignees that can include AI agents. [Read more →](/docs/how-it-works/task-lists)
- **Code** — A Monaco-powered code editor (the same engine as VS Code) with syntax highlighting and real-time collaboration. [Read more →](/docs/how-it-works/code)

## Page hierarchy

All nine types compose into a single recursive tree:

\`\`\`
📁 Project/                    (Folder)
├── 📄 Requirements            (Document)
├── 📋 Sprint Board            (Task List)
├── 💬 Team Chat               (Channel)
├── 🤖 Project AI              (AI Chat)
├── 📊 Budget                  (Sheet)
├── 🎨 Dashboard               (Canvas)
├── 💻 config.json             (Code)
└── 📁 Assets/                 (Folder)
    ├── 📎 logo.png            (File)
    └── 📎 brief.pdf           (File)
\`\`\`

Any page type can be a child of any folder — folders don't restrict what lives inside them. The tree drives AI context and navigation. Permissions come from drive membership and per-page grants, not folder position, so moving a page between folders doesn't change who can see it.
`;

export default function PageTypesPage() {
  return <DocsMarkdown content={content} />;
}

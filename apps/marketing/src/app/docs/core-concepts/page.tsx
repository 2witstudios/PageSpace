import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Core Concepts",
  description: "Foundational principles of PageSpace: pages as primitives, tree-structured hierarchy, context inheritance, and recursive composition.",
  path: "/docs/core-concepts",
  keywords: ["core concepts", "architecture", "pages", "hierarchy", "context"],
});

const content = `
# Core Concepts

These are the foundational principles that underpin every data model, API, and UI pattern in PageSpace.

## 1. Pages Are the Universal Primitive

Everything in PageSpace is a **page**: documents, folders, AI chats, channels, task lists, sheets, canvases, code files, and uploaded files. This single recursive content model enables:

- **Nestable composition**: A document can contain a folder, which contains a task list, which contains an AI chat
- **Unified search**: All content types are searchable through the same API
- **Consistent permissions**: One permission model for all content types
- **Universal mentions**: @mention any page type from anywhere

\`\`\`
📁 Project/                  ← FOLDER page
├── 📄 Requirements          ← DOCUMENT page
├── 📋 Sprint Board          ← TASK_LIST page
├── 💬 Team Chat             ← CHANNEL page
├── 🤖 Project AI            ← AI_CHAT page
└── 📁 Assets/               ← FOLDER page
    └── 📎 brief.pdf         ← FILE page
\`\`\`

## 2. Structure Encodes Meaning

The tree hierarchy isn't just organization — it's **semantics**. Moving a page to a new parent changes its meaning, just like moving a word in a sentence changes the sentence's meaning.

This spatial-semantic model drives three systems:

- **Permissions**: Drive owners have full access; page permissions are per-user on specific pages
- **AI context**: An AI agent inside a project folder understands that project
- **Navigation**: Breadcrumbs, tree views, and search all operate on the hierarchy

## 3. Context Flows Through the Tree

**Drive ownership grants access to every page in the drive.** Page-level grants are per-page only — there is no automatic inheritance from a parent page to its children. If you want a teammate to see a whole subtree, grant each page in it.

**AI agents are location-aware.** An agent's system prompt is automatically populated with its drive, its breadcrumb path, and the page it lives on.

\`\`\`
📁 Marketing Campaign/
├── 📄 Brand Guidelines
├── 📄 Target Audience
└── 🤖 Campaign AI          ← Knows its path is "Marketing Campaign / Campaign AI"
\`\`\`

That path is the hook. To pull in Brand Guidelines or Target Audience, the agent calls workspace tools like \`list_pages\` or \`read_page\` — the tree tells it where to look; the tools fetch the content.

## 4. Drives Are the Root of Ownership

A **drive** is a top-level workspace. Every drive has a single owner with irrevocable full access.

- Drives contain pages in a tree structure
- Team members are added at the drive level with roles: \`OWNER\`, \`ADMIN\`, or \`MEMBER\`
- Each user gets a personal drive on signup
- You can create unlimited additional drives for different projects or teams

## 5. AI Is a First-Class Citizen

AI conversations aren't bolted on — they're **pages in the tree**. This means:

- AI conversations are searchable, shareable, and mentionable
- Multiple users can chat with the same AI simultaneously
- AI agents inherit context from their position in the hierarchy
- Different agents can have different providers, models, tools, and system prompts
- Agents can consult each other via the \`ask_agent\` tool

## 6. Database-First Persistence

Every message, every edit, every tool call is persisted to PostgreSQL immediately. This is not client-side state management — it's durable, queryable storage.

Benefits:
- **Multi-user collaboration**: Database is the single source of truth
- **Searchable history**: Find information across all conversations
- **Audit trails**: Complete record of all AI interactions
- **Real-time sync**: Socket.IO broadcasts database changes to all connected users
- **No data loss**: Messages are never stored only in memory

## 7. Recursive UI Mirrors the Data Model

The frontend isn't a set of disjoint apps — it's a recursive viewer of a recursive model. The same page tree powers:

- The sidebar navigation
- Breadcrumb trails
- Search results
- AI context windows
- Permission management
- Drag-and-drop reordering

One data model powers every interface, making the system both extensible and predictable.
`;

export default function CoreConceptsPage() {
  return <DocsMarkdown content={content} />;
}

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

**Permissions flow downward.** If you own a drive, you own every page in it. Page-level permissions grant specific access to specific users on specific pages.

**AI context flows upward.** An AI agent nested inside a folder can reference its sibling and parent pages. This means:

\`\`\`
📁 Marketing Campaign/
├── 📄 Brand Guidelines
├── 📄 Target Audience
└── 🤖 Campaign AI          ← Can reference Brand Guidelines and Target Audience
\`\`\`

The Campaign AI inherits context from its location. It knows about Brand Guidelines and Target Audience because they're siblings in the same folder. This context awareness is automatic — no configuration required.

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

## 7. Tags Are Orthogonal Context

While the tree encodes **structural** meaning (this document belongs to this project), tags encode **cross-cutting** context (this document is a draft, high priority, or tagged "Q1").

Tags are additive metadata — they never override structural meaning. Pages can be filtered, grouped, or surfaced across the tree using tags.

## 8. Recursive UI Mirrors the Data Model

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

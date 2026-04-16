export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  content: string;
  author: string;
  date: string;
  readTime: string;
  category: string;
  featured?: boolean;
  image?: string;
}

export function formatDate(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export const blogPosts: Record<string, BlogPost> = {
  "your-workspace-is-the-context": {
    slug: "your-workspace-is-the-context",
    title:
      "Your Workspace Is the Context: How PageSpace Teaches AI Where It Is",
    description:
      "Most AI tools dump flat text into a prompt. PageSpace gives AI a map — a tree structure that encodes location, hierarchy, and meaning. Here's how workspace organization becomes AI understanding.",
    image: "/blog/workspace-is-the-context.png",
    content: `
## The Problem with Flat Context

Most AI tools work like this: take a blob of text, shove it into the system prompt, hope the model figures it out.

There's no structure. No location. No hierarchy. The AI doesn't know where it is, what's around it, or how the information relates to anything else. It's reading a book with no table of contents, no chapters, no page numbers.

You end up doing the work the AI should be doing — explaining what project this is, what files are relevant, what conventions apply. Every session. Every time.

The problem isn't the AI's capability. It's that nobody gave it a map.

## The Tree as a Semantic Structure

PageSpace organizes everything in a page tree. Folders, documents, AI agents, chat channels, spreadsheets, canvases — they all live in a hierarchical structure you design.

This isn't just a UI convenience. The tree *is* the context model.

Where a page lives tells the AI what it means. A document called "API Design" under \`/Engineering/Backend/\` carries different weight than a document with the same name under \`/Archive/Old Drafts/\`. The path encodes intent, scope, and relevance — without you writing a single annotation.

When you organize your workspace, you're not just tidying up for yourself. You're teaching the AI how your work is structured.

## Breadcrumb Path Injection

When you chat with an AI agent in PageSpace, the system builds a breadcrumb path from the page's position in the tree and injects it directly into the system prompt.

Here's what the AI actually receives — the real \`PAGE CONTEXT\` block from the system prompt builder:

\`\`\`
PAGE CONTEXT:
• Location: /engineering/backend/api-design
• Type: DOCUMENT
• Path: Engineering > Backend > API Design
• When users say "here", they mean this page
\`\`\`

The AI now knows it's looking at an API design document inside the backend section of the engineering workspace. When you say "here," it means something specific. When you say "update this," the AI knows exactly what "this" refers to.

No ambiguity. No guessing. The tree position resolves it.

## Workspace Structure as a Map

Beyond knowing its own location, the AI can receive the entire workspace tree — formatted as a visual hierarchy that mirrors the structure you built.

Here's the real format, generated from PageSpace's tree formatter:

\`\`\`
├── 📁 Engineering
│   ├── 📄 Architecture Overview
│   ├── 🤖 Code Review Agent
│   └── 📁 Backend
│       ├── 📄 API Design
│       └── 📄 Database Schema
└── 📁 Product
    ├── 📄 Roadmap
    └── 💬 Team Discussion
\`\`\`

The AI can see sibling pages, parent folders, and the full organizational context. It knows that "Architecture Overview" and "Code Review Agent" sit alongside the "Backend" folder. It can decide what to read based on structure, not guesswork.

When someone asks "what do we know about the backend?" the AI doesn't search blindly — it looks at the Backend folder, sees what's there, and reads what's relevant. The tree tells it where to look.

## Inline Instructions — What the AI Knows About Itself

Beyond location, the AI receives contextual rules that define how it should behave in this specific context. These come from PageSpace's inline instruction system:

\`\`\`
CONTEXT:
• Current location: "API Design" [DOCUMENT] at /eng/backend/api-design in "Engineering"
• DriveSlug: eng, DriveId: abc123
• When user says "here" or "this", they mean this location
• Explore current drive first (list_pages) before other drives
\`\`\`

The AI also receives page type documentation — what each type can do, what operations make sense. It knows that a DOCUMENT page supports rich text editing and content updates. It knows that a SPREADSHEET page has structured data. It knows that an AI_CHAT page is a conversation.

Add workspace-level rules — your team's conventions, writing style preferences, tool restrictions — and the AI's behavior becomes specific to where it's operating, not generic across all contexts.

## The Tools — How the AI Explores

PageSpace doesn't just give the AI a static context dump. It gives the AI real tools to explore your workspace actively:

- **\`list_pages\`** — Browse the tree structure, see what's inside any folder
- **\`read_page\`** — Read the full content of any page in the workspace
- **\`regex_search\`** — Search content across pages with regex patterns, returns matches with line numbers and semantic paths
- **\`glob_search\`** — Find pages by path patterns like \`**/meeting-notes/*\` or \`engineering/**\`
- **\`multi_drive_search\`** — Search across all workspaces at once when the answer might live somewhere else
- **\`ask_agent\`** — Call another AI agent in the workspace, delegating specialized questions to agents with domain expertise

The AI doesn't just receive context passively — it can actively navigate. The tree gives it a map. The tools let it move through it. When the AI needs to find related documents, it doesn't ask you to paste them. It searches, reads, and synthesizes on its own.

## Page Agents: Context-Aware AI in the Tree

Page agents are AI_CHAT pages that live in the tree alongside your documents. They're not separate from your workspace — they're part of it.

Each agent can be configured with:

- **Custom system prompts** — specific instructions for what this agent knows and how it should behave
- **Tool permissions** — allow only read tools for a research agent, or write tools for an editor agent
- **Page tree visibility** — see only children of the current folder, or the full drive structure
- **Drive prompt inclusion** — inherit workspace-level instructions and conventions

Here's why the tree matters for agents: an agent nested under \`/Engineering/Backend/\` naturally has context about backend engineering. Its position in the tree encodes its purpose. A "Code Review Agent" sitting next to "Architecture Overview" and "API Design" inherently understands its scope — it's there to review code in the context of that architecture and those APIs.

You don't need to write elaborate prompts explaining what the agent should focus on. The tree already told it.

## The Composable Prompt

All of this comes together in how PageSpace assembles the final system prompt. It's not one monolithic block — it's built from discrete, composable layers:

1. **Core role definition** — the base personality and capabilities
2. **User personalization** — your bio, writing style, custom rules
3. **Location context** — breadcrumbs, drive info, page type
4. **Workspace structure** — the tree, visible as a map
5. **Inline instructions** — contextual rules for this specific location
6. **Timestamp context** — current date, time, and timezone
7. **Agent awareness** — list of other agents available to consult

Each layer is independently cacheable. Each is determined by the tree position — different locations produce different prompts. An agent in the Engineering folder gets engineering context. An agent in Product gets product context. Same underlying model, different understanding.

The tree isn't just organizing your files. It's programming the AI.

## Why This Matters

AI that knows where it is makes better decisions.

It doesn't need you to explain the project structure — it can see the tree. It doesn't need you to point at related documents — it can find them. It understands that a page under "Architecture Decisions" is different from a page under "Meeting Notes" even if they mention the same topic.

Structure is meaning. A flat list of documents is just noise. A tree is a semantic model — every folder boundary, every nesting level, every sibling relationship carries information about how your work fits together.

When you organize your PageSpace workspace, you're not doing busywork. You're building the context model that makes your AI actually useful. The workspace *is* the prompt.

Your workspace is the context. Make it a good one.
    `,
    author: "Jono",
    date: "2026-02-17",
    readTime: "9 min read",
    category: "Product",
    featured: true,
  },
  "pagespace-as-memory-for-coding-agents": {
    slug: "pagespace-as-memory-for-coding-agents",
    title: "Using PageSpace as Memory for Your Coding Agent",
    description:
      "Coding agents are stateless. Every session starts from scratch. Here's how to give them persistent memory with PageSpace and MCP — including cloud agents that intelligently retrieve the right context.",
    image: "/blog/pagespace-memory-coding-agents.png",
    content: `
## The Problem: Your Coding Agent Has Amnesia

Every time you start a new session with your coding agent, it forgets everything. The architecture decisions you explained yesterday. The conventions your team agreed on last week. The debugging session where you finally figured out that weird race condition.

You re-explain the same context over and over. You paste the same docs into chat. You point at the same files and say "remember, we do it this way."

CLAUDE.md files help — they give your agent a starting point. But they're static, local to one repo, and limited in what they can capture. They're a sticky note on the monitor, not a knowledge base.

What if your coding agent could actually remember?

## What If Your Agent Had a Knowledge Base?

Imagine a persistent, organized workspace your coding agent can read from, write to, and search across. Not files buried in your repo — a structured knowledge system that:

- **Persists across sessions** — context survives after you close your terminal
- **Works across projects** — your React conventions apply whether you're in the frontend repo or the monorepo
- **Shares across machines** — same knowledge base on your laptop and your CI server
- **Stays organized** — not a flat dump of text, but a hierarchy of pages, folders, and agents

That's what PageSpace gives your coding agent.

## PageSpace + MCP: The Connection

PageSpace publishes an MCP server — \`pagespace-mcp\` on npm — that exposes your knowledge base to any coding agent that supports the Model Context Protocol.

Install it, point it at your PageSpace instance with a token, and your coding agent gets direct access to search, read, and write pages in your workspace.

MCP is the protocol. PageSpace is the memory.

## Setup

Add PageSpace to your coding agent's MCP configuration:

\`\`\`json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "pagespace-mcp@latest"],
      "env": {
        "PAGESPACE_API_URL": "https://your-instance.pagespace.ai",
        "PAGESPACE_AUTH_TOKEN": "your-mcp-token"
      }
    }
  }
}
\`\`\`

Generate an MCP token from your PageSpace workspace settings. The token is scoped to a specific drive, so you control exactly what your agent can access.

That's it. Your coding agent can now search your knowledge base, read pages, create new ones, and update existing content — all through natural tool calls.

## The Real Differentiator: Cloud Agents

Here's where PageSpace goes beyond "document storage your agent can read."

PageSpace has **page agents** — cloud AI agents with custom instructions that live inside your knowledge base. They're not just documents. They're intelligent retrieval and processing layers that sit between your coding agent and your knowledge.

When your coding agent calls PageSpace via MCP, it can talk to these page agents. That means:

**Smart retrieval, not keyword search.** Instead of your coding agent trying to guess which document has the answer, it can ask a page agent: "What are our conventions for error handling in API routes?" The page agent knows the knowledge base, understands the question, and returns the relevant context.

**Summarization on demand.** A page agent can digest a 20-page architecture doc into the three paragraphs your coding agent actually needs for its current task.

**Knowledge base maintenance.** Page agents can organize incoming information. Your coding agent writes a raw note about a decision you made — a page agent files it properly, links it to related docs, and keeps the knowledge base clean.

**Shared context across agents.** Multiple coding agents — yours, your teammate's, your CI pipeline's — all read from and write to the same workspace. Page agents ensure consistency. One source of truth, many consumers.

This is the difference between giving your agent a filing cabinet and giving it a research assistant.

## What to Put in Your Knowledge Base

Start with what you find yourself re-explaining to your coding agent:

- **Architecture decisions and rationale** — why you chose that database, why the auth works that way, why you split that service
- **Coding conventions and patterns** — how you structure components, naming rules, error handling patterns, test conventions
- **API documentation** — internal APIs, external integrations, authentication flows
- **Debugging playbooks** — "when X happens, check Y" knowledge that's hard to capture in code comments
- **Meeting notes and decisions** — the context behind the code, not just the code itself
- **Project roadmaps** — what's planned, what's in progress, what's blocked and why

The key insight: anything you'd explain verbally to a new team member belongs in your knowledge base. Your coding agent is a new team member every single session.

## Security

Giving an AI agent access to your knowledge base requires trust in the access model:

- **Drive-scoped tokens** — each MCP token is scoped to a single drive. Your agent sees only what you explicitly share
- **Audit logging** — every read and write through MCP is logged
- **Fail-closed permissions** — if the token doesn't grant access, the request is denied. No fallbacks, no defaults

You control the boundary. The agent works within it.

## Getting Started

1. Create a PageSpace account and set up a drive for your project knowledge
2. Add your architecture docs, conventions, and patterns as pages
3. Create page agents with instructions tailored to your workflow
4. Generate an MCP token and add the config to your coding agent
5. Start a session and ask your agent to check the knowledge base

Your coding agent just got a memory. Use it.
    `,
    author: "Jono",
    date: "2026-02-17",
    readTime: "8 min read",
    category: "Guide",
  },
  "google-calendar-sync-setup": {
    slug: "google-calendar-sync-setup",
    title: "How to Connect Google Calendar and Let AI See Your Schedule",
    description:
      "A step-by-step guide to connecting Google Calendar with PageSpace. Two-way sync, calendar selection, and how to use AI agents that can actually check your availability and schedule meetings.",
    image: "/blog/google-calendar-sync-setup.png",
    content: `
## Why This Matters

Your AI agent can read your documents, search your workspace, write content, and manage tasks. It has no idea what's on your calendar.

Every scheduling suggestion is a guess. Every prioritization ignores the meeting you have in 30 minutes. Every "when should we do this?" turns into an alt-tab to Google Calendar and a manual relay back.

Connecting Google Calendar to PageSpace fixes that. Your events sync in, your AI agents get real tools to query your schedule and create events that push back to Google. This guide walks through setup.

## Step 1: Connect Your Google Account

Open **Settings** in PageSpace. Under integrations, find **Google Calendar** and click **Connect Google Calendar**.

You'll be redirected to Google's consent screen. PageSpace requests read and write access to your calendars. Write access is needed so AI-created events can push back to Google.

Grant the permissions. Google redirects you back to PageSpace. You'll see a green "Connected" badge with your Google email on the settings page.

If the flow fails, PageSpace tells you why. Most common: you clicked cancel ("Access denied") or waited too long to complete it ("State expired"). Click Connect again.

## Step 2: Pick Your Calendars

Once connected, PageSpace fetches your available Google calendars and displays them as a checklist. Your primary calendar is selected by default.

You'll see every calendar on your Google account. Primary, work, holidays, shared team calendars, that "Birthdays" calendar you forgot you had. Each one shows its color dot and name.

Check the ones you want to sync. Uncheck the ones you don't. Changes save immediately, and PageSpace triggers a sync for any newly selected calendar so events appear right away.

You need at least one calendar selected. If you try to uncheck all of them, PageSpace blocks it.

## Step 3: First Sync

After connecting, PageSpace runs an initial sync automatically. It pulls events from the past 30 days through the next 90 days. This gives your AI agents enough historical context for patterns and enough future context for scheduling.

The first sync might take a few seconds depending on how many events you have. After that, sync is incremental. Only changed events transfer. Google sends push notifications to PageSpace in real time when events change, and a background job polls every 15 minutes as a fallback. Between the two, your PageSpace calendar stays current without you doing anything.

You can always hit **Sync Now** on the settings page to force an immediate sync. The page shows your last sync time and how many events are currently synced.

## Two-Way Sync

Events from Google appear in your PageSpace calendar. Events created in PageSpace push back to Google. A colleague reschedules through Google, PageSpace picks it up. Your AI agent creates a "Project Review" event, it shows up on your phone.

When an agent schedules a meeting, it's not creating a PageSpace-only event nobody else can see. It's a real calendar event that lands in Google Calendar for every attendee.

## What Your AI Can Do With Your Calendar

Once connected, your AI agents get calendar tools. Not a read-only view. Real tools with real parameters.

**See your schedule.** The agent lists events in any date range across all synced calendars. "What do I have this week?" gets a real answer.

**Check availability.** The agent queries a date range and gets back free time slots. It respects working hours. It merges overlapping events. A meeting from 2:00 to 3:00 and a call from 2:30 to 3:30 show as one busy block, not two.

**Schedule meetings.** The agent creates events with title, time, duration, location, recurrence, attendees, and visibility. The event pushes to Google Calendar automatically.

**Manage the full lifecycle.** Update events, cancel them, RSVP on your behalf, add or remove attendees.

These are the tools an executive assistant would need.

## Scheduling Example

You're in a PageSpace AI chat working on a project, and you type:

*"Schedule a 30-minute project review with the team for sometime Thursday afternoon. Find a slot that works."*

The agent calls \`check_calendar_availability\` for Thursday afternoon. Finds 2:00 to 2:30 open. Calls \`create_calendar_event\` with the title, time slot, and your workspace members as attendees. The event syncs to Google Calendar. Everyone sees it on their phone. You never left the chat.

That's the difference between a calendar display widget and calendar tools.

## Time-Triggered Agents

Calendar events can trigger AI agents to run at event time.

When you create an event in PageSpace, you can attach an AI agent page and a prompt. When the event arrives, the agent wakes up with full event context and executes.

Practical example: create a recurring event, "Weekly Metrics Review," every Monday at 9am. Attach your analytics agent with instructions to read the latest data pages in your workspace and write a summary document. Every Monday morning, the agent runs. It reads live data. It writes the report. No human involvement. The summary is always current because the agent reads what exists now, not a cached snapshot.

Another one. Project deadline is Friday. Create an event, "Pre-deadline check," Thursday at 4pm. Attach a project agent with instructions to review the open tasks and post a status summary. Thursday afternoon, the agent runs a check for you while you're still in meetings.

The trigger system checks drive access, agent page existence, and your daily AI usage limit before executing. If any check fails, nothing runs and nothing breaks.

The calendar becomes a scheduler for AI work.

## Security and Permissions

AI calendar tools go through the exact same permission system as every other tool in PageSpace. If you can't see an event, your AI agent can't either. If you're not a member of a drive, calendar queries for that drive return nothing.

Tokens are encrypted at rest. Webhook authentication is cryptographically signed. Token refresh happens automatically before expiration so sync never fails mid-request.

Your calendar data is encrypted, never shared with third parties, and you can disconnect at any time from the settings page. Disconnecting revokes your token on Google's side and stops all sync.

Connect your calendar. Let your AI see your schedule.
    `,
    author: "Jono",
    date: "2026-04-15",
    readTime: "5 min read",
    category: "Guide",
  },
  "ai-versioning-safety": {
    slug: "ai-versioning-safety",
    title:
      "The Undo Button for AI: How Three Layers of Versioning Make Full Agent Access Safe",
    description:
      "AI needs write access to be useful, but write access without a safety net is reckless. PageSpace builds versioning and rollback so deep that any AI change can be reversed instantly — at the page, conversation, or entire workspace level.",
    image: "/blog/ai-versioning-safety.png",
    content: `
## The Access Dilemma

There's a tension at the center of every AI-powered workspace tool, and most of them pretend it doesn't exist.

If your AI can only read your content, it's a search engine with a personality. It can summarize, answer questions, maybe find a document you forgot about. Useful, but limited. You still do all the actual work — creating pages, editing text, organizing files, updating spreadsheets.

If your AI can write, edit, create, and delete — now it's a collaborator. It can draft documents, reorganize your workspace, update task lists, edit code, build out entire project structures. That's where the real productivity gains live. An AI that can only look at your work is an observer. An AI that can change your work is a partner.

But write access is terrifying.

What happens when the AI misunderstands your request and rewrites your carefully crafted architecture document? What happens when it deletes pages it shouldn't have touched? What happens when a multi-step AI operation goes sideways halfway through — three pages updated, two created, one renamed — and you need to get back to where you were?

Most platforms pick a side. Either they restrict the AI to keep things safe (and lose most of the value), or they hand over full access and hope their model is good enough to not break things (and it isn't, always).

There's a third option: give the AI real tools, and make everything it does reversible.

## What "Reversible" Actually Requires

Saying "we have version history" isn't enough. A basic version history that saves a copy every time you hit save doesn't solve the AI problem.

AI doesn't edit like humans do. A human opens a document, reads it, makes a few changes, saves. An AI agent might update five pages in a single conversation turn. It might create new pages, edit existing ones, and reorganize the tree — all in response to a single prompt. The changes are fast, distributed across multiple resources, and linked by conversational context that a simple version timeline knows nothing about.

To make AI actions truly reversible, you need versioning that understands three things:

1. **What changed on each individual page** — so you can restore a single page without affecting everything else
2. **What the AI did across an entire conversation** — so you can undo a multi-page operation as one atomic action
3. **What your entire workspace looked like at a point in time** — so you can recover from anything, no matter how many changes were made

PageSpace builds all three.

## Layer 1: Page Versions — The Automatic Snapshot

Every time a page is modified in PageSpace, a version is created. This happens whether a human or an AI made the change. But here's the detail that matters for AI safety: the system tags versions differently depending on who initiated the edit.

When a human edits a page, the version source is tagged as \`auto\`. When an AI agent edits a page, the version source is tagged as \`pre_ai\`.

This isn't a label for display purposes. It's a first-class concept in the database schema — a dedicated enum value that the entire versioning system understands. The system knows, at the data level, that this version exists because an AI was about to change something.

Why does this matter? Because when you're looking at a page's version history, you can see exactly where the AI intervened. You can see the state of the page immediately before the AI touched it. And you can restore to that exact point with one click.

Each version captures:

- **The full page content** — stored with a SHA-256 content reference, optionally compressed for large pages
- **The content format** — whether it's rich text, markdown, JSON, or raw HTML
- **A state hash** — a computed fingerprint of the page's complete state (title, content, position, settings), so the system can detect if the page has been modified since the version was created
- **The page revision number** — a monotonically increasing counter that detects concurrent edits

Versions are retained for 30 days by default. If a version is important — say, it's the last known-good state before a major AI-driven rewrite — you can pin it, and it's exempt from expiration.

This isn't "undo" in the Ctrl+Z sense. It's a complete, content-addressable snapshot of every page state, with AI changes explicitly marked as a distinct source.

## Layer 2: Conversation Undo — Reversing What the AI Did

Page versions let you restore individual pages. But AI agents don't just edit one page at a time.

In a single conversation, an AI agent in PageSpace might create a new document, edit an existing one, update a spreadsheet, rename a page, and move something into a different folder. Each of those actions creates its own page version and activity log entry. But from the user's perspective, those five changes were one thing: "the AI did what I asked."

If the result isn't what you wanted, you don't want to manually find and revert five separate page versions. You want to undo everything the AI did from that point forward.

That's what conversation undo does.

When you trigger an undo on any message in a PageSpace AI conversation, the system finds every change that the AI made at or after that message. It traces the connection through the conversation ID that's stamped on every activity log entry — every page create, update, delete, rename, and move that the AI performed during that conversation.

You get two options:

**Messages only** — Remove the conversation messages from that point forward (soft-delete, not permanent destruction). The AI's changes to pages stay in place. Use this when the AI said something unhelpful but the actual edits were fine.

**Messages and changes** — Remove the messages AND roll back every change the AI made to your workspace. Every page edit reverted. Every page creation undone. Every rename reversed. All of it, atomically, in a single database transaction.

Before any of this executes, you get a preview. The system shows you exactly how many messages will be removed, exactly which pages and activities will be affected, and whether any of those pages have been modified since the AI touched them (conflict detection). If someone else — or you — made additional edits on top of the AI's changes, the system warns you. You can force the rollback if you want, but you'll know what you're overriding.

This isn't just "go back to a previous version." This is "identify every side effect of a multi-step AI operation and reverse all of them as one unit."

## Layer 3: Drive Backups — The Full Workspace Snapshot

Pages and conversations are fine-grained. But sometimes you need the nuclear option.

Maybe you handed an AI agent a broad instruction and it reorganized half your workspace. Maybe you're about to let a new AI agent loose on your knowledge base and you want a checkpoint first. Maybe it's Tuesday and you just want a backup.

Drive backups capture everything:

- **Every page in the workspace** — including content, metadata, and tree position (you can optionally include trashed pages too)
- **All permissions** — who has access to what, at what level
- **All members and their roles** — the full team structure
- **All files** — attachments, uploads, everything stored in the drive

Backups can be created manually (click a button), on a schedule (automated), or automatically before a restore operation (so restoring from a backup doesn't destroy your current state — the system snapshots what you have before overwriting it).

Each backup records page count, total content size, custom labels, and an optional reason field. You can annotate your backups: "Before letting the new research agent run" or "Pre-migration checkpoint."

This is the "I don't know exactly what went wrong but I need to get back to last Thursday" layer.

## The Audit Trail — Knowing Exactly What Happened

Versioning lets you go back. The audit trail lets you understand what happened in the first place.

Every action an AI takes in PageSpace is logged with full attribution:

- **Which AI provider and model** performed the action (not just "AI did this" — you know it was Claude 3.5 Sonnet, or GPT-4, or whatever model you're using)
- **Which conversation** the action was part of — linking the change back to the exact chat where you gave the instruction
- **What changed** — previous values and new values for every modified field
- **State hashes before and after** — cryptographic proof of what the page looked like before and after the change
- **The agent chain** — if a sub-agent was involved (one AI agent delegating to another), the full chain of delegation is recorded

This matters for teams. When three people are using AI agents in the same workspace, and someone notices a document looks different, the audit trail tells you which agent changed it, which conversation initiated it, and which user was driving that conversation. No ambiguity. No "the AI did it" with no further details.

## Permission Checks Still Apply

A common fear with AI agents is that they'll access things they shouldn't — reading private documents, editing pages in someone else's project, deleting things outside their scope.

In PageSpace, AI agents go through the exact same permission system as human users. Every single tool call — create, edit, delete, rename, move — checks permissions before executing.

If a user doesn't have edit access to a page, their AI agent doesn't either. If a drive is restricted to certain members, an AI agent operating on behalf of a non-member gets denied. There's no backdoor, no elevated privilege, no "the AI needs access so we'll skip the check."

The permission functions are centralized — the same code path that validates a human's edit request validates the AI's. One system. One set of rules. Whether you're clicking a button or the AI is calling a tool, the access check is identical.

## Why This Approach Beats the Alternatives

**Restricting AI to read-only** means you're leaving most of the value on the table. An AI that can't actually do things for you is an expensive search box. You still write every document, organize every folder, update every spreadsheet yourself. The AI watches.

**Giving AI full access with no safety net** works until it doesn't. And when it doesn't, the cost is high — lost content, broken organization, hours of manual recovery. The more powerful the AI, the more damage a single bad instruction can cause. "Just be careful with your prompts" is not a safety strategy.

**Making AI actions reversible at every level** is the approach that lets you actually use AI for real work without anxiety. You don't need to craft the perfect prompt. You don't need to review every change before it's made. You give the AI an instruction, see what it does, and if the result isn't right, you roll it back — one page, one conversation, or the entire workspace.

The safety isn't in preventing the AI from acting. It's in making every action undoable.

## What This Looks Like in Practice

You're working on a product launch. You ask your AI agent to draft documentation for three new features across three separate pages.

The AI creates the pages, writes the content, organizes them under the right folder. Each page gets a \`pre_ai\` version snapshot automatically. Every action is logged with the conversation ID, the model used, and the full before/after state.

You review the drafts. Two are great. One completely missed the point.

You have options. You can restore that one page to its pre-AI state using the page version history. Or if the AI also made structural changes you don't like — moved things around, renamed the folder — you can undo the entire conversation, reverting every change the AI made in that session. Or if you realize this after a week of additional work and just want to grab the pre-AI content from that one page, the version is still there, tagged and searchable.

At no point did you lose anything. At no point were you at the mercy of the AI getting it right the first time.

## The Uncomfortable Truth About AI Access

Here's what the industry doesn't want to talk about: AI models will make mistakes. They'll misinterpret instructions. They'll take actions you didn't intend. This isn't a bug that will be fixed in the next model release — it's an inherent property of working with systems that interpret natural language.

The question isn't whether your AI will ever do the wrong thing. It's what happens when it does.

If the answer is "you lose your work" or "you spend an hour manually fixing things" — that's a platform problem, not an AI problem. The model will get better over time. But even a perfect model operating on an ambiguous instruction will sometimes produce the wrong result.

The platforms that win won't be the ones with the most powerful AI. They'll be the ones where using powerful AI is safe. Where you can give an AI agent real tools — create, edit, delete, reorganize — and know that no matter what happens, you can get back to where you were.

That's what three layers of versioning gets you. Not a restriction on what AI can do. A guarantee that whatever it does can be undone.
    `,
    author: "Jono",
    date: "2026-04-10",
    readTime: "10 min read",
    category: "Product",
  },
};

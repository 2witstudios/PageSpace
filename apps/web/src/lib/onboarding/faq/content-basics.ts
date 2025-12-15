export const FAQ_START_HERE = `
# Start Here

Welcome to PageSpace.

This **FAQ** folder is a mini knowledge base you can keep forever. It’s designed to be browsed like a handbook:

- **FAQ Index** answers common questions and points you to the right page.
- **Page Types** explains each page type with:
  - a short **Guide** (what it’s for + how to use it)
  - a hands-on **Example** page nested right next to the guide

## The quickest way to learn (5 minutes)

1. Open **Page Types → Documents → Documents (Guide)**, then open **Documents (Example)**.
2. Open **Page Types → Sheets → Sheets (Example: Budget)** and edit a few cells.
3. Open **Page Types → Task Lists → Task Lists (Example: Project Tracker)** and check off a task.
4. Open **Page Types → Canvas → Canvas (Example: Mini Dashboard)**.
5. Open **Page Types → Workspace Templates → Workspace Templates (Guide)** and browse a template that matches your work.
6. Open **Page Types → AI Automations → AI Automations (Guide)** and skim the pipeline patterns (including \`ask_agent\`).
7. Ask the **About PageSpace Agent** anything — it’s configured to use this FAQ as its knowledge base.

## How to ask good questions

Tell the agent what you’re trying to do, not just what you’re clicking:

- “I’m organizing research notes for a project — what structure should I use?”
- “I want tasks that each have a notes page — how do Task Lists work here?”
- “When should I use a Sheet vs a Document table?”
- “Can you recommend a workspace template for a solo founder and explain why?”
- “Show me an automation pipeline where one agent delegates to specialists using \`ask_agent\`.”
`.trim();

export const FAQ_INDEX = `
# FAQ Index

## Basics

- **What is a drive?** A drive is a workspace (like a project space). Drives contain pages.
- **What is a page?** A page is the main unit of content in PageSpace: documents, sheets, task lists, canvases, channels, and AI chats.
- **How do I organize things?** Use folders and nested pages. See **Page Types → Folders → Folders (Guide)**.

## Page Types (which should I use?)

- **I’m writing notes / specs / meeting notes** → **Documents**
- **I need structured data and formulas** → **Sheets**
- **I want tasks where each task has its own page** → **Task Lists**
- **I’m uploading PDFs/images/code and want previews** → **Files**
- **I want a custom UI / dashboard** → **Canvas**
- **I want a team chat thread** → **Channels**
- **I want a dedicated AI agent with instructions** → **AI Chat**

Open **Page Types** to see a guide + a working example for each.

## Workspace templates (structure you can copy)

If you’re not sure how to organize a new drive, start here:

- **Which template should I copy?** See **Page Types → Workspace Templates → Workspace Templates (Guide)**.
- Templates included: **Solo Book Writing**, **Solo Founder**, **Small Business**, **Dev Team**.

## AI in PageSpace

- **Where does the AI “knowledge” come from?** Agents can be configured with a system prompt. In this drive, the **About PageSpace Agent** uses the FAQ content as its baseline knowledge.
- **Can I make my own agent?** Yes. See **Page Types → AI Chat → AI Chat (Guide)**.
- **Can an agent read my pages?** Only if it has the right tools enabled and you have permission to those pages.
- **Can agents work in a pipeline?** Yes. See **Page Types → AI Automations → AI Automations (Guide)** and **Page Types → AI Automations → Automation Examples (Use Cases)**.

## Collaboration & Permissions

- **Why can’t I edit a page?** You might have view-only permission. See **Collaboration → Sharing & Permissions**.
- **Does PageSpace support real-time?** Yes for many page types. See **Collaboration → Real-time Collaboration**.
`.trim();


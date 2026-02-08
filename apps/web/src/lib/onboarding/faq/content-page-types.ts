import { createEmptySheet, serializeSheetContent } from '@pagespace/lib';

export const FOLDERS_GUIDE = `
# Folders (Guide)

Folders are how you build structure in PageSpace.

## What folders are for

- Group related pages (projects, teams, clients, topics)
- Create "tables of contents" by nesting pages under a folder
- Keep examples and templates separate from real work

## How to use folders well

1. Start with a small number of top-level folders (2-6).
2. Nest pages one level deep first, then go deeper only when it earns its keep.
3. Use consistent naming (e.g., "Meetings", "Specs", "Research", "Assets").
`.trim();

export const DOCUMENTS_GUIDE = `
# Documents (Guide)

Documents are the default "thinking and writing" page type in PageSpace.

## Use Documents for

- Notes, specs, wikis, meeting notes
- Checklists and lightweight planning
- Drafting content you'll later share

## What makes Documents powerful here

- Rich text + markdown-style structure (headings, lists, etc.)
- Easy nesting (Documents can live inside any folder)
- Great companions to Task Lists (task pages are Documents)
`.trim();

export const SHEETS_GUIDE = `
# Sheets (Guide)

Sheets are for structured data, quick calculations, and lightweight modeling.

## Use Sheets for

- Budgets and totals
- Simple trackers and lists
- Formulas and calculations

## Formulas (quick intro)

- Start a formula with \`=\`
- Reference cells like \`A1\`, ranges like \`A1:B10\`
- Example: \`=SUM(B2:B10)\`
`.trim();

export const FILES_GUIDE = `
# Files (Guide)

File pages represent uploaded files (PDFs, images, code, docs) with metadata like file name, type, and size.

## How File pages are created

You usually don't create a File page manually — it appears when you upload a file into a folder or drive.

## What to expect

- Many common file types can be previewed.
- All files can be downloaded.
- Some files may take time to process before their content is searchable/readable by AI.
`.trim();

export function buildBudgetSheetContent(): string {
  const sheet = createEmptySheet(20, 8);
  sheet.cells = {
    A1: 'Item',
    B1: 'Cost',
    A2: 'Hosting',
    B2: '20',
    A3: 'Domain',
    B3: '12',
    A4: 'Email',
    B4: '8',
    A6: 'Total',
    B6: '=SUM(B2:B4)',
  };

  return serializeSheetContent(sheet);
}

export const TASK_LISTS_GUIDE = `
# Task Lists (Guide)

Task Lists are for managing work where **each task can have its own page**.

## How Task Lists work in PageSpace

- A Task List page contains tasks (status, priority, due date, assignee).
- For page-based task lists, each task can be linked to a Document page for notes, context, and collaboration.

## What to use Task Lists for

- Projects where every task needs notes
- Client work where tasks need context and history
- Personal planning with "task pages" (perfect for checklists + details)
`.trim();

export const CANVAS_GUIDE = `
# Canvas (Guide)

Canvas pages render **custom HTML + CSS** inside PageSpace.

## Use Canvas for

- Mini dashboards
- Landing pages for a project
- Visual "home pages" that link to the rest of your drive

## Tips

- Keep canvases small and focused (one screen).
- Use them as navigation hubs: show the most important pages and next actions.
- If something is blocked, it's usually for safety (Canvas is designed to be secure).
`.trim();

export const CHANNELS_GUIDE = `
# Channels (Guide)

Channels are for team conversation, like a lightweight chat room attached to your workspace.

## Use Channels for

- Ongoing discussion with teammates
- Quick questions and updates
- Conversations that don't belong inside a document
`.trim();

export const AI_CHAT_GUIDE = `
# AI Chat (Guide)

AI Chat pages are dedicated agents. Think of them as "bots with instructions."

## What makes an AI Chat page different?

- It has a **system prompt** (its permanent instructions)
- It can have **tools enabled** (like reading pages or searching)
- It keeps conversation history on that page

## How to use AI Chat pages well

- Be specific in the system prompt ("You help me write specs for X").
- Give it a format (checklists, headings, step-by-step).
- Keep it narrow. Make more agents instead of one mega-agent.
`.trim();

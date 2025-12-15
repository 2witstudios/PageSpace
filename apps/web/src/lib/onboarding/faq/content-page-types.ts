import { createEmptySheet, serializeSheetContent } from '@pagespace/lib';

export const FOLDERS_GUIDE = `
# Folders (Guide)

Folders are how you build structure in PageSpace.

## What folders are for

- Group related pages (projects, teams, clients, topics)
- Create “tables of contents” by nesting pages under a folder
- Keep examples and templates separate from real work

## How to use folders well

1. Start with a small number of top-level folders (2–6).
2. Nest pages one level deep first, then go deeper only when it earns its keep.
3. Use consistent naming (e.g., “Meetings”, “Specs”, “Research”, “Assets”).

## Try it

Open **Folders (Example: Project Folder)** and use it as a template for your first real project folder.
`.trim();

export const DOCUMENTS_GUIDE = `
# Documents (Guide)

Documents are the default “thinking and writing” page type in PageSpace.

## Use Documents for

- Notes, specs, wikis, meeting notes
- Checklists and lightweight planning
- Drafting content you’ll later share

## What makes Documents powerful here

- Rich text + markdown-style structure (headings, lists, etc.)
- Easy nesting (Documents can live inside any folder)
- Great companions to Task Lists (task pages are Documents)

## Try it

Open **Documents (Example)** and:

1. Duplicate it.
2. Replace the title.
3. Add your own section headings.
`.trim();

export const DOCUMENTS_EXAMPLE = `
# Document Example: Meeting Notes

## Agenda

- Project updates
- Decisions needed
- Next steps

## Notes

Write freely. Use headings and lists to keep things skimmable.

## Decisions

- Decision 1:
- Decision 2:

## Action Items

- [ ] Action item one
- [ ] Action item two
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

## Try it

Open **Sheets (Example: Budget)** and change a few values in the Cost column.
`.trim();

export const FILES_GUIDE = `
# Files (Guide)

File pages represent uploaded files (PDFs, images, code, docs) with metadata like file name, type, and size.

## How File pages are created

You usually don’t create a File page manually — it appears when you upload a file into a folder or drive.

## What to expect

- Many common file types can be previewed.
- All files can be downloaded.
- Some files may take time to process before their content is searchable/readable by AI.

## Try it

Open **Files (Example: Upload Here)** and upload a file into that folder.
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
- Personal planning with “task pages” (perfect for checklists + details)

## Try it

Open **Task Lists (Example: Project Tracker)** and:

1. Mark a task as done.
2. Open one of the task pages nested under the task list.
3. Add notes to the task page.
`.trim();

export const CANVAS_GUIDE = `
# Canvas (Guide)

Canvas pages render **custom HTML + CSS** inside PageSpace.

## Use Canvas for

- Mini dashboards
- Landing pages for a project
- Visual “home pages” that link to the rest of your drive

## Tips

- Keep canvases small and focused (one screen).
- Use them as navigation hubs: show the most important pages and next actions.
- If something is blocked, it’s usually for safety (Canvas is designed to be secure).

## Try it

Open **Canvas (Example: Mini Dashboard)** and tweak the text and colors.
`.trim();

export const CANVAS_MINI_DASHBOARD = `
<!DOCTYPE html>
<html>
  <head>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        margin: 0;
        padding: 32px;
        background: radial-gradient(1200px circle at 20% 0%, #e0e7ff, transparent 55%),
          radial-gradient(900px circle at 80% 20%, #d1fae5, transparent 45%),
          #0b1020;
        color: #e5e7eb;
        min-height: 100vh;
      }
      .wrap {
        max-width: 860px;
        margin: 0 auto;
      }
      .title {
        font-size: 28px;
        font-weight: 650;
        letter-spacing: -0.02em;
        margin: 0 0 8px;
      }
      .subtitle {
        opacity: 0.85;
        margin: 0 0 22px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }
      .card {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 14px;
        padding: 16px;
        backdrop-filter: blur(10px);
      }
      .card h3 {
        margin: 0 0 6px;
        font-size: 14px;
        opacity: 0.9;
      }
      .card p {
        margin: 0;
        font-size: 13px;
        opacity: 0.78;
        line-height: 1.35;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.12);
        font-size: 12px;
        margin-top: 14px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1 class="title">Canvas Example: Mini Dashboard</h1>
      <p class="subtitle">
        This page is a Canvas. It renders custom HTML/CSS so you can build dashboards and navigation hubs.
      </p>

      <div class="grid">
        <div class="card">
          <h3>1) Write</h3>
          <p>Create Documents for notes, specs, and meeting logs.</p>
        </div>
        <div class="card">
          <h3>2) Track</h3>
          <p>Use Task Lists when each task needs its own notes page.</p>
        </div>
        <div class="card">
          <h3>3) Calculate</h3>
          <p>Use Sheets for budgets, totals, and quick modeling.</p>
        </div>
      </div>

      <div class="pill">
        <strong>Try:</strong>
        <span>Change a color, edit text, and make it your “home page”.</span>
      </div>
    </div>
  </body>
</html>
`.trim();

export const CHANNELS_GUIDE = `
# Channels (Guide)

Channels are for team conversation, like a lightweight chat room attached to your workspace.

## Use Channels for

- Ongoing discussion with teammates
- Quick questions and updates
- Conversations that don’t belong inside a document

## Try it

Open **Channels (Example: Team Chat)** and send a message.
`.trim();

export const AI_CHAT_GUIDE = `
# AI Chat (Guide)

AI Chat pages are dedicated agents. Think of them as “bots with instructions.”

## What makes an AI Chat page different?

- It has a **system prompt** (its permanent instructions)
- It can have **tools enabled** (like reading pages or searching)
- It keeps conversation history on that page

## How to use AI Chat pages well

- Be specific in the system prompt (“You help me write specs for X”).
- Give it a format (checklists, headings, step-by-step).
- Keep it narrow. Make more agents instead of one mega-agent.

## Try it

Open **AI Chat (Example Agent)** and ask it to help plan something small.
Then edit the agent’s system prompt to make it more specialized.
`.trim();


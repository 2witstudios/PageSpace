import { createEmptySheet, serializeSheetContent } from '@pagespace/lib';

export const WORKSPACE_TEMPLATES_GUIDE = `
# Workspace Templates (Guide)

A good PageSpace structure does two jobs:

1. Helps humans find things quickly.
2. Makes your workspace **discoverable context** for AI agents.

## What “discoverable context” means

Agents can:

- See a workspace tree (if enabled for that agent)
- List pages and paths via tools (e.g., \`list_pages\`)
- Search by title/content (e.g., \`glob_search\`, \`regex_search\`)
- Read the pages they find (e.g., \`read_page\`)

If your drive uses predictable names and has a few “anchor pages”, an agent can reliably locate the right context without you pasting it into chat.

## Recommended anchor pages (put these near the top of a project)

- **README / Project Brief**: what this is, goals, constraints, “definition of done”
- **Decisions**: what was decided + why
- **Glossary**: acronyms, terms, naming conventions
- **Status / Weekly Notes**: current state and next actions
- **Sources**: files and links that matter

## Where agents belong

Put an **Agents** folder inside each major project area. Keep agents narrow:

- one job
- one type of output
- a clear “where to write results” convention

## Templates included in this FAQ

- **Solo Book Writing (Template)**
- **Solo Founder (Template)**
- **Small Business (Template)**
- **Dev Team (Template)**

## How to copy a template into real work

1. Duplicate a template folder.
2. Move it to your drive root.
3. Rename it.
4. Delete the FAQ copy if you want — the structure is the point, not the location.

## How structure helps automation (example)

If you keep a predictable structure like:

- \`/Product/PRDs\`
- \`/Sprint/Sprint Board\`
- \`/Engineering/RFCs\`

…then an agent can:

1. Find the right pages with \`list_pages\` or \`glob_search\`
2. Read the relevant documents with \`read_page\`
3. Create tasks/pages with tool calls (see **AI Automations** section)
`.trim();

export const BOOK_TEMPLATE_README = `
# Solo Book Writing (Template)

This template is designed for writing a book solo while still getting leverage from AI agents.

## Structure (high level)

- **00 Inbox**: capture messy ideas without worrying about organization
- **01 Manuscript**: the source of truth for the actual writing
- **02 Research**: characters/world/sources
- **03 Publishing**: checklists and release planning
- **Agents**: specialized helpers that know how this structure is laid out

## Discoverable context (why this works for AI)

Keep a few “anchor pages” stable and easy to find:

- **01 Manuscript → Book Brief**
- **01 Manuscript → Outline**
- **02 Research → Character Bible**
- **01 Manuscript → Style Guide**

If those pages exist and stay named consistently, an agent can reliably locate them via \`list_pages\` + \`read_page\`.

## Example agent automations (ideas)

- **Chapter pipeline**:
  1) “Outline the next chapter” (planning)
  2) “Draft scene beats” (drafting)
  3) “Continuity check” (consistency)
  4) “Copy edit pass” (polish)

See **Page Types → AI Automations → Automation Examples (Use Cases)** for pipeline patterns using \`ask_agent\`.
`.trim();

export const FOUNDER_TEMPLATE_README = `
# Solo Founder (Template)

This template is built for a founder who needs product thinking, execution, and ops in one place.

## Structure (high level)

- **00 Inbox**: capture raw notes and TODOs
- **Product**: vision, PRDs, roadmap
- **Customers**: interviews, notes, insights
- **Operations**: weekly review, finance, admin
- **Agents**: specialized helpers (strategy, synthesis, planning)

## Discoverable context

The most “AI-useful” pages are the ones that stay stable:

- **Product → Vision**
- **Product → PRDs → PRD Template / Active PRDs**
- **Operations → Weekly Review**

Agents can find these consistently if you keep titles predictable and avoid burying anchors too deeply.

## Example agent automations (ideas)

- Turn an interview note into:
  - a summary
  - key insights
  - follow-up questions
  - a PRD skeleton

- Weekly review pipeline:
  - summarize wins/losses
  - propose next priorities
  - update a task list for the week
`.trim();

export const SMALL_BUSINESS_TEMPLATE_README = `
# Small Business (Template)

This template focuses on repeatable operations: clients, delivery, sales, and SOPs.

## Structure (high level)

- **00 Inbox**: capture quick notes and requests
- **Clients**: one folder per client (work, files, notes, tasks)
- **Operations**: SOPs, policies, admin
- **Sales & Marketing**: leads, campaigns, content
- **Agents**: onboarding, SOP writing, support triage

## Discoverable context

Predictability is power:

- Every client folder has the same “anchor” pages (Overview, Tasks, Notes).
- SOPs live in one place with consistent titles.

Agents can discover and operate on this structure by searching for “Client - ” folders, then reading anchor pages and updating task lists.
`.trim();

export const DEV_TEAM_TEMPLATE_README = `
# Dev Team (Template)

This template is designed to connect product intent → engineering execution → ongoing operations.

## Structure (high level)

- **00 Inbox**: capture issues and ideas
- **Product**: PRDs and decisions
- **Engineering**: RFCs, runbooks, architecture notes
- **Sprint**: task lists where each task has its own page
- **Channels**: lightweight team chat
- **Agents**: planning, PRD-to-tasks, RFC review

## Discoverable context

Agents can be effective when:

- PRDs live in **Product → PRDs**
- RFCs live in **Engineering → RFCs**
- Sprint execution lives in a predictable **Sprint Board** task list

That predictability means an orchestrator can find the right inputs fast (\`glob_search\` / \`list_pages\`) and then create tasks (\`update_task\`).
`.trim();

export function buildFounderMetricsSheetContent(): string {
  const sheet = createEmptySheet(20, 8);
  sheet.cells = {
    A1: 'Week',
    B1: 'Users',
    C1: 'Revenue',
    D1: 'Notes',
    A2: '2025-W01',
    B2: '120',
    C2: '500',
    D2: 'First onboarding experiment',
    A3: '2025-W02',
    B3: '160',
    C3: '820',
    D3: 'Improved activation',
  };
  return serializeSheetContent(sheet);
}

export function buildSalesPipelineSheetContent(): string {
  const sheet = createEmptySheet(20, 10);
  sheet.cells = {
    A1: 'Lead',
    B1: 'Stage',
    C1: 'Value',
    D1: 'Next Step',
    A2: 'ExampleCo',
    B2: 'Discovery',
    C2: '2500',
    D2: 'Schedule kickoff call',
    A3: 'Northwind',
    B3: 'Proposal',
    C3: '8000',
    D3: 'Send revised scope',
  };
  return serializeSheetContent(sheet);
}


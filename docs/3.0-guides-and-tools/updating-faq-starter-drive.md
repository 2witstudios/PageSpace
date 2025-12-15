# Updating the FAQ Starter Drive

This branch seeds a “starter drive” for every new user on signup. The starter drive includes a **FAQ** folder (a mini knowledge base) and an **About PageSpace Agent** AI chat that’s configured to use the FAQ as its baseline reference.

This guide explains how to add/change/update that seeded FAQ content (and keep the agent in sync), so admins/devs can maintain it manually or with AI assistance.

## What gets seeded (and where)

Seeding happens in `apps/web/src/lib/onboarding/drive-setup.ts` via `populateUserDrive(userId, driveId)`:

- A “Welcome to PageSpace” Document (inline content in `drive-setup.ts`)
- A “FAQ” Folder tree (from `apps/web/src/lib/onboarding/faq/seed-template.ts` and `apps/web/src/lib/onboarding/faq/seed/*`)
- An “About PageSpace Agent” AI Chat page (system prompt from `apps/web/src/lib/onboarding/faq/about-agent-system-prompt.ts`)

The seeded FAQ page bodies live as TypeScript string constants (Markdown/HTML/etc.) in:

- `apps/web/src/lib/onboarding/faq/content-basics.ts`
- `apps/web/src/lib/onboarding/faq/content-page-types.ts`
- `apps/web/src/lib/onboarding/faq/content-workspace-templates.ts`
- `apps/web/src/lib/onboarding/faq/content-ai-automations.ts`
- `apps/web/src/lib/onboarding/faq/content-other.ts`

## Quick checklist (don’t skip this)

When you change the FAQ seed, keep these aligned:

1. Update the page content (`content-*.ts`)
2. Update the page tree (add/move/rename nodes in `seed-template.ts` / `seed/*`)
3. Update cross-references inside the FAQ (paths mentioned in text like “FAQ → Page Types → …”)
4. Update the “About PageSpace Agent”:
   - If you changed titles/paths, update the “FAQ map” section in `apps/web/src/lib/onboarding/faq/about-agent-system-prompt.ts`
   - If you added a new “canonical” doc the agent should know without searching, add it to `apps/web/src/lib/onboarding/faq/knowledge-base.ts`

## Editing existing FAQ pages (content changes only)

If you’re just improving wording or adding sections to an existing seeded page:

1. Find the content constant in `apps/web/src/lib/onboarding/faq/content-*.ts` (e.g. `FAQ_START_HERE`, `DOCUMENTS_GUIDE`, `AI_PRIVACY`).
2. Edit the string content.
3. Keep the format consistent:
   - These are TypeScript template literals wrapped in backticks and `.trim()`.
   - If you need literal backticks in the output, escape them in a template literal, e.g.:

     ```ts
     Use \`ask_agent\` to delegate to another agent.
     ```

Because the agent knowledge base imports the same constants, content-only changes automatically update both:

- The seeded FAQ page content
- The knowledge base appended to the About PageSpace Agent prompt (for pages listed in `knowledge-base.ts`)

## Adding a new FAQ page (new doc/folder)

To add a new seeded FAQ page:

1. Create the content source:
   - Add a new exported constant in an existing `content-*.ts` file, or add a new `content-*.ts` module (keep filenames kebab-case).
2. Add it to the seeded tree:
   - Update `apps/web/src/lib/onboarding/faq/seed-template.ts` (or `apps/web/src/lib/onboarding/faq/seed/*` if it belongs to Page Types / Templates / Automations).
   - Pick the correct `type`:
     - `DOCUMENT` content is Markdown-ish text
     - `CANVAS` content is HTML/CSS
     - `SHEET` content should be generated via helpers (see `buildBudgetSheetContent()` in `apps/web/src/lib/onboarding/faq/content-page-types.ts`)
     - `TASK_LIST` tasks are defined in `taskList` (and get their own linked task pages via seeding logic)
3. Update the in-FAQ navigation text:
   - Update `FAQ_INDEX` (and/or `FAQ_START_HERE`) so users can find the new page.
4. Update the agent to match:
   - Add the new page to the “FAQ map” paths in `apps/web/src/lib/onboarding/faq/about-agent-system-prompt.ts` if it’s something the agent should reference directly.
   - Add the new page’s content constant to `apps/web/src/lib/onboarding/faq/knowledge-base.ts` if it should be part of the agent’s built-in knowledge base snapshot.

## Renaming or moving seeded FAQ pages (title/path changes)

If you rename a page title or move it in the tree, you must update **all** references that assume exact titles:

- `apps/web/src/lib/onboarding/faq/seed-template.ts` and/or `apps/web/src/lib/onboarding/faq/seed/*` (the actual seeded titles/structure)
- Any FAQ content text that references paths by title (common in `content-basics.ts`, `content-page-types.ts`, etc.)
- The About PageSpace Agent “FAQ map” in `apps/web/src/lib/onboarding/faq/about-agent-system-prompt.ts` (it uses exact seeded titles)

Optional but recommended:

- Keep the document’s first Markdown heading aligned with the page title (e.g., page title “Troubleshooting (FAQ)” and content starts with `# Troubleshooting (FAQ)`).

## Updating the “About PageSpace Agent”

The “About PageSpace Agent” is seeded as an `AI_CHAT` page in `apps/web/src/lib/onboarding/drive-setup.ts` with:

- `systemPrompt: getAboutPageSpaceAgentSystemPrompt()`
- `enabledTools: ['read_page', 'list_pages', 'glob_search', 'regex_search']`
- `includePageTree: true` + `pageTreeScope: 'drive'`
- `includeDrivePrompt: true`

There are two source files to keep in sync:

1. `apps/web/src/lib/onboarding/faq/about-agent-system-prompt.ts`
   - Update the “FAQ map” section whenever seeded titles/paths change.
   - Add new sections/behaviors if the FAQ adds new top-level concepts.
2. `apps/web/src/lib/onboarding/faq/knowledge-base.ts`
   - This is the curated list of docs appended to the system prompt as the agent’s knowledge base snapshot.
   - Add new “canonical” docs here if you want the agent to know them without searching the page tree.

## Previewing changes locally

Fastest sanity check is to seed a fresh drive:

1. Start DB + web app:
   - `pnpm dev:db`
   - `pnpm --filter web dev`
2. Create a new account (or otherwise trigger signup flow) so `populateUserDrive` runs.
3. Verify:
   - FAQ tree and new/changed pages exist and render correctly
   - About PageSpace Agent references the correct paths (no stale “FAQ map” entries)

## Rollout notes (existing users vs new users)

- This seed only runs when a drive is created during signup (see `apps/web/src/lib/onboarding/drive-setup.ts` call sites).
- Updating the seed changes what **new** users get after you deploy.
- Existing users’ already-seeded FAQ pages (and the About PageSpace Agent system prompt stored on that AI Chat page) do **not** update automatically.

If you need to update existing drives:

- Manual: edit the relevant pages and the agent’s system prompt in the UI.
- AI-assisted (in-app): use an automation agent with write tools enabled (e.g. `replace_lines` for Documents; `update_agent_config` if you want an agent to update another agent’s system prompt). Be explicit about scope and review diffs.

## AI-assisted workflow (updating the seed in code)

When you ask an AI coding assistant to update the FAQ seed, be explicit about the “sync points” so it updates all the right files. Example prompt:

> Update the onboarding FAQ seed to add a new “Billing & Plans (FAQ)” doc under the top-level `FAQ` folder and link it from `FAQ Index`. Keep titles consistent and update any path references. Also update the About PageSpace Agent so it references the new page in its FAQ map and include the new doc in the knowledge base list if appropriate.

Minimum “done” criteria for any AI-generated change:

- `seed-template.ts` reflects the new structure/titles
- The relevant `content-*.ts` page content is updated/added
- `about-agent-system-prompt.ts` FAQ map matches the new titles/paths
- `knowledge-base.ts` includes any new canonical docs you expect the agent to know without searching

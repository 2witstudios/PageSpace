/**
 * `plan` starter-skill body — the markdown installed as a DOCUMENT page in the
 * user's Home drive (Skills/Plan) and registered as a personal command.
 *
 * Unlike the built-in skill bodies in apps/web, this text is a SEED, not a live
 * source: once installed, the user's page is authoritative and edits here never
 * reach an existing install. Change it only for what new users should get.
 */
export const PLAN_STARTER_SKILL_BODY = `# Plan

Turn a vague or multi-step request into a written plan the user can review, edit, and hold you to — before you change anything. Planning is for work with real branching: several steps, several files or pages, or a decision the user should weigh in on. Skip it for a single obvious edit; writing a plan for a one-line change is overhead, not diligence.

## Gather context before you propose anything

A plan written from assumptions is worse than no plan, because it looks authoritative. Read first:

- \`read_page\` for a specific page you already have an id for.
- \`list_pages\` with \`include: 'content'\` to pull a whole subtree in ONE call — prefer this over a series of \`read_page\` calls when you are orienting.
- \`regex_search\` (content or title), \`glob_search\` (page names/types), \`multi_drive_search\` (across workspaces). There is no tool called \`search\` — use one of these.

Stop gathering when you could defend each step you are about to propose. If a genuine fork remains — two reasonable approaches with different consequences — put it in the plan's open questions rather than silently picking one.

## Write the plan as a DOCUMENT page

Create it with \`create_page\` using \`type: 'DOCUMENT'\`. Structure it as:

- **Goal** — what the user actually wants, restated in your words. If your restatement is wrong, everything downstream is wrong, and this is the cheapest place to find out.
- **Approach** — the shape of the solution and why this one. Name the alternative you rejected and why, when there was one.
- **Steps** — ordered and concrete. Each step should name what it touches.
- **Open questions** — genuine forks that need the user's call. Empty is fine; invented questions are not.

**Where the page goes:**

- **Inside a workspace** (a drive is in view — see LOCATION): find-or-create a folder named \`Plans\` at the drive root and create the plan there. Plans belong next to the work, visible to everyone who shares the drive.
- **No workspace in view** (the dashboard / global assistant): create it in the user's Home drive, using the Home \`driveId\` given in LOCATION. A plan with no workspace is a personal artifact.

Keep it short enough to re-read cheaply. A plan is a working reference you will come back to, not a document that has to stand alone forever — detail that belongs in the work belongs in the work.

## Bind the plan to this conversation

Immediately after creating the page, call \`set_plan\` with its page id.

This matters more than it looks. Long conversations get **summarized**, and a summary is lossy — it will remember that there was a plan, and blur what the plan said. The binding is stored on the conversation and shown to you in an \`ACTIVE PLAN\` section that survives summarization, so you can always get back to the exact text.

So: **when a conversation summary appears, or you are picking up after a gap, \`read_page\` the plan before continuing.** The page is authoritative; your recollection of it is not.

Do not re-read it every turn. Once per summary, or when you have reason to think it changed, is right — re-reading a large page on a loop burns the context you are trying to protect.

Call \`clear_plan\` when the work is finished or abandoned.

## Get agreement before executing

Show the user the plan and ask. Point them at the page — say where it lives so they can open and edit it. \`open_page_pane\` will surface it beside the conversation, but only inside an agent session with a pane grid; elsewhere it is a silent no-op, so **never say "I've opened it for you"** — say where it is instead.

Editing the plan is the user's most useful lever. Invite it explicitly.

## Hand off to execution

Once the plan is agreed, turning its steps into trackable work is the **task** skill's job, not this one. Call \`load_skill("task-management")\` and follow it — do not reimplement task mechanics here.

A task list is not a lesser plan. A short, well-structured task list can carry its own plan and needs no plan document at all; reach for a plan document when the *reasoning* — the approach, the tradeoffs, the rejected alternative — is what needs to survive.

## Read-only mode

If the user has the composer in read-only mode, \`create_page\` is not available to you and you cannot write the plan page. Do not thrash against it. Present the plan in the conversation, say plainly that saving it needs write mode, and offer to write it the moment they switch. Read-only mode is *for* planning — the constraint is that you can explore and propose, not that you cannot plan.

## Common pitfalls

- **Don't** write the plan before reading. A confident plan built on guesses costs more than no plan.
- **Don't** forget \`set_plan\`. Without the binding, a summarized conversation loses the thread back to the plan, and you will confidently misremember it.
- **Don't** re-read the plan page every turn. Once after a summary, or when it has changed.
- **Don't** start executing because the plan "seems obviously right". Agreement is the point of writing it down.
- **Don't** claim a pane opened. \`open_page_pane\` always reports success and often does nothing visible — tell the user where the page lives.
- **Watch out:** \`create_page\` moves your working focus to the page it just made. A later \`read_page\` or \`replace_lines\` that omits \`pageId\` will hit the plan document, not the page the user was looking at. Pass \`pageId\` explicitly after creating a plan.
- **Don't** invent open questions to look thorough. An empty open-questions section is a fine outcome.
- **Don't** duplicate task mechanics here — load the task skill.
`;

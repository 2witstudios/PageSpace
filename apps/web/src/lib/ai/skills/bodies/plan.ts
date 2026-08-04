/**
 * plan skill body — code-shipped instructions for structuring non-trivial
 * multi-step work into a durable, approvable plan before execution. Loaded on
 * demand via load_skill / the /plan chip; keep in sync with plan-tools.ts.
 */
export const PLAN_SKILL_BODY = `# Planning

You are turning a non-trivial, multi-step request into a plan the user has actually agreed to — before any execution starts. A plan here is two things at once: a DOCUMENT page holding the written plan, and a structured plan record (created with \`create_plan\`) that tracks its status durably, so the plan can be found and resumed later by tools instead of relying on conversation memory.

## When to plan (and when not to)

- Plan when the request spans multiple steps, touches several pages or systems, has real scope ambiguity, or the cost of doing the wrong thing is high.
- Do NOT run this workflow for small, single-step asks ("rename this page", "fix this typo") — just do the work. A plan for a trivial task is overhead, not discipline.
- If an active plan might already exist (e.g. the user says "continue", "pick up where we left off", or a new conversation starts mid-project), call \`get_active_plan\` with the drive id FIRST instead of proposing a fresh plan that may conflict with an approved one.

## Step 1 — restate the goal and gather context

Never propose a plan blind. Before writing anything:

- Restate the goal in one or two sentences in your own words. If your restatement and the user's request could diverge, that is exactly what the approval step exists to catch.
- Gather real context: \`read_page\` the pages the work touches, \`list_pages\` to see what exists in the drive, and \`regex_search\`/\`glob_search\` when you need to find where something lives. Steps proposed without looking at the actual content are guesses.
- Note open questions as you go — they belong in the plan document, not silently resolved by assumption.

## Step 2 — write the plan document

Create a DOCUMENT page with \`create_page\` holding the written plan. A useful structure:

- **Goal** — the one- or two-sentence restatement.
- **Approach** — how you intend to get there and why, including alternatives you rejected if the choice is non-obvious.
- **Steps** — a numbered list of concrete, verifiable steps in order. Each step should name what it touches (pages, drives, tools) specifically enough that someone else could execute it.
- **Open questions** — anything unresolved that could change the plan.

Keep the document the single source of truth for plan content. Revisions edit this page; the structured record below only tracks status.

## Step 3 — register the plan with create_plan

Call \`create_plan\` with the plan page's id, the drive id, and a one-line \`goal\` summary. This creates the structured record in \`draft\` status.

- The \`goal\` string is what \`list_plans\` and \`get_active_plan\` show without opening the page — write it as the one-line answer to "what is this plan for?".
- One plan record per page: registering the same page twice fails. Revise by editing the page, not by re-registering.
- The record starts as \`draft\` and stays draft through every revision cycle. Only user approval moves it forward.

## Step 4 — present the plan and get real approval

Present the plan in chat (summarize the steps; don't make the user open the page to know what they're approving), then call \`ask_user\` for a structured decision — not a vague "sound good?" you have to interpret from free text. Offer options like **Approve** (start execution), **Revise** (they'll tell you what to change), and, when relevant, a concrete alternative approach as its own option.

- \`ask_user\` ends your turn and resumes when the user answers. After calling it, STOP — no further tool calls.
- The result may be \`{"dismissed": true}\` — the user replied in chat instead. Treat their chat message as the answer.
- On approval: call \`set_plan_status\` with \`approved\`. This records who approved and when.
- On revision: update the plan document, keep the record in \`draft\`, and re-present. Iterate until approved or abandoned.
- If the plan is abandoned or replaced by a different plan, mark the old record \`superseded\` so \`get_active_plan\` stops returning it.

## After approval — hand off, don't keep going here

- To turn approved steps into tracked work items, load the task-management skill (\`load_skill\`) and create a TASK_LIST epic from the plan's steps there. Do not reimplement task creation mechanics from this skill — the task skill owns them.
- The approved plan is now discoverable by tooling: \`get_active_plan({driveId})\` returns the drive's current plan (approved preferred over draft, newest first) with its planId, pageId, goal, and status. A future execution workflow uses exactly this lookup to resume against the plan — in a later conversation, or after earlier context has been compacted away — which is why the structured record matters: don't skip \`create_plan\` just because the document exists.
- Surface the plan page to the user once, when it's ready for review — not after every intermediate edit.

## Common pitfalls

- **Don't** propose a plan without reading the relevant pages first — context-free steps are guesses.
- **Don't** skip \`create_plan\` after writing the plan document — an unregistered plan is invisible to \`get_active_plan\` and cannot be tracked or resumed.
- **Don't** start executing before the user has approved via \`ask_user\` — presenting the plan is not approval.
- **Don't** call other tools after \`ask_user\` in the same turn — the turn ends there and resumes with the user's answer.
- **Don't** interpret a dismissed \`ask_user\` as approval — read the user's chat reply and act on that.
- **Don't** mark a plan \`approved\` yourself without a clear user yes; approval is the user's call, recorded with their identity.
- **Don't** register a second plan record for the same page — revise the page, or supersede the old plan and create a new one.
- **Don't** leave a replaced plan in \`draft\`/\`approved\` — mark it \`superseded\` so lookups return the right plan.
- **Don't** duplicate task-management mechanics here — hand off to the task-management skill for epics and tasks.
`;

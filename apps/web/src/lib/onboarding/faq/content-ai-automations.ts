export const AI_AUTOMATIONS_GUIDE = `
# AI Automations (Guide)

In PageSpace, “automation” usually means an AI agent using tools to:

- create pages and folders
- read and summarize documents
- search your workspace
- create and update tasks (with linked task pages)

## The key pattern: Orchestrator + Specialists

You can build a pipeline where one “orchestrator” agent delegates to specialist agents using \`ask_agent\`.

### Why this works

- The orchestrator owns the plan and tool calls.
- Specialists stay narrow (e.g., “extract tasks from a PRD”, “write a meeting summary”).
- The orchestrator stitches outputs together and executes changes with tools.

## A safe automation workflow (recommended)

1. **Plan first**: the agent proposes what it will create/change.
2. **Confirm scope**: where in the drive it should write (folder/page IDs).
3. **Execute**: tool calls create/update pages or tasks.
4. **Review**: the agent summarizes what changed and links you to results.

## What makes your drive automation-friendly

- Stable “anchor pages” (README, Decisions, Glossary, Status)
- Predictable folder names (templates help)
- A dedicated area for automation outputs (e.g., “Automation Playground”)

## Pipeline building blocks (conceptual)

- \`list_agents\` → discover specialist agents
- \`ask_agent\` → delegate a step and get a structured answer
- \`list_pages\` / \`glob_search\` / \`regex_search\` → find context
- \`read_page\` → load the context
- \`create_page\` / \`replace_lines\` → write documents
- \`update_task\` → create/update tasks (auto-creates linked task pages)

See **Automation Examples (Use Cases)** for concrete pipelines you can copy.
`.trim();

export const AI_AUTOMATIONS_EXAMPLES = `
# Automation Examples (Use Cases)

These examples are written as “pipelines”. They assume you have:

- an **orchestrator agent** with tools enabled
- one or more **specialist agents** (called via \`ask_agent\`)
- a predictable workspace structure (templates help)

## 1) Solo book writing: Chapter pipeline

Goal: create a new chapter doc with an outline, then run a consistency pass.

Pipeline:

1. Orchestrator reads **Book Brief** + **Outline**.
2. Orchestrator calls \`ask_agent\` on a specialist: “Propose chapter outline and scene beats.”
3. Orchestrator creates \`/01 Manuscript/Chapters/Chapter XX\`.
4. Orchestrator calls \`ask_agent\` on a consistency specialist: “Find contradictions vs Character Bible.”
5. Orchestrator writes a “Continuity Notes” section into the chapter doc.

## 2) Solo founder: Customer interview → insights → roadmap

Goal: turn a raw interview note into actionable product work.

Pipeline:

1. Orchestrator finds the interview page in **Customers → Interviews** and reads it.
2. Orchestrator calls \`ask_agent\`: “Extract pain points, quotes, and opportunities.”
3. Orchestrator writes an “Insights” doc in **Customers**.
4. Orchestrator creates or updates tasks in a roadmap task list via \`update_task\`.

## 3) Small business: New client onboarding

Goal: create a client folder with standard pages + a task list.

Pipeline:

1. Orchestrator creates \`Clients/Client - <Name>\` with \`create_page\`.
2. Orchestrator creates “Overview”, “Notes”, and “Deliverables” docs.
3. Orchestrator creates an “Onboarding Tasks” task list and adds tasks via \`update_task\`.
4. Orchestrator drafts a welcome email in a doc for you to review.

## 4) Dev team: PRD → sprint tasks

Goal: turn a PRD into a sprint board with tasks.

Pipeline:

1. Orchestrator locates the PRD under **Product → PRDs** and reads it.
2. Orchestrator calls \`ask_agent\`: “Return a structured task breakdown with owners and acceptance criteria.”
3. Orchestrator creates a “Sprint Board” task list.
4. Orchestrator creates tasks via \`update_task\` so each task gets a linked notes page.

Tip: \`ask_agent\` supports persistent conversations. Keep a \`conversationId\` per specialist so the pipeline can iterate over time.
`.trim();

export const AUTOMATION_PLAYGROUND_README = `
# Automation Playground

Use this folder as a safe place to experiment with agent pipelines.

Recommended flow:

1. Open **Automation Orchestrator (Example)**.
2. Ask it to propose an automation plan before it changes anything.
3. Tell it exactly where to write outputs (this folder is safest).

If you want an automation to affect a real project, duplicate the relevant workspace template and ask the orchestrator to operate only inside that project folder.
`.trim();


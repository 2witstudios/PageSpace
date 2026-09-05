/**
 * Inline Instructions for AI Chat
 *
 * Minimal, trust-the-model instructions appended to system prompts.
 * The model infers tool usage from schemas; these provide context-specific rules.
 */

// AUTHORING RULE: These sections correct format mistakes and non-intuitive workflows.
// Do NOT list tool names here — the model already receives a flat tool list and can call tool_search.
// Add a bullet only when the model predictably gets it wrong without explicit guidance.

import { BUILTIN_SKILLS, isSkillEligible } from '@pagespace/lib/commands/command-core';

// ---------------------------------------------------------------------------
// Shared sections — identical in both page-context and global-assistant flows
// ---------------------------------------------------------------------------

const WORKSPACE_RULES = `WORKSPACE RULES:
• Any page type can contain any other - organize for user needs, not type conventions
• Always read before write. FILE pages are read-only (uploads).
• Provide both driveId and driveSlug for operations.
• Before creating a page, list_pages its destination to check for existing duplicates`;

/**
 * PAGE TYPES section. The DOCUMENT/SHEET/CANVAS/TASK_LIST bullets each have
 * a full variant and a slim skill-pointer variant — the deep conventions
 * live in the on-demand skill bodies (apps/web/src/lib/ai/skills/bodies),
 * loaded only when the work actually touches that domain.
 *
 * A bullet slims ONLY when its specific skill is eligible for this agent
 * (load_skill present AND the skill's requiredTools intersect the agent's
 * tools — the same isSkillEligible the catalog uses). Anything else — no
 * load_skill, a stripped allowlist, read-only mode, or the undefined
 * include-all sentinel used by the admin prompt viewer — keeps that
 * bullet's FULL text, so the stable prompt never points at a skill the
 * catalog doesn't advertise.
 *
 * Slimming rule: a bullet may only shrink here if the corresponding skill
 * body covers it verbatim-or-better.
 */
const PAGE_TYPE_BULLETS: ReadonlyArray<{
  full?: string;
  slim?: string;
  skill?: string;
  /**
   * Builds the bullet from the tools the agent actually holds, instead of
   * choosing between fixed strings. Used where a bullet names several tools and
   * any of them may be absent from a saved allowlist.
   */
  compose?: (availableTools?: string[]) => string;
  /** Appended to a composed bullet when its skill pointer is usable. */
  slimSuffix?: string;
}> = [
  { full: '• FOLDER: Container with list/icon view of children. Accepts file uploads via drag-drop.' },
  {
    // Composed for the same reason the SHEET bullet is: it names tools that may
    // be absent from a saved allowlist. Every agent configured before
    // copy_content existed has one, and telling those agents to call it buys an
    // unknown-tool round trip. The skill/slim branch is reproduced here because
    // `compose` takes precedence over `slim` in buildPageTypes.
    compose: (availableTools?: string[]) => {
      if (skillPointerUsable(availableTools, 'writing-documents')) {
        return '• DOCUMENT: Markdown or rich text stored as HTML (check contentMode). Load the writing-documents skill before non-trivial writing or line-range editing.';
      }
      const parts = [
        '• DOCUMENT: Markdown text, or rich text stored as HTML (contentMode says which; documents you create default to markdown).',
        'Write the format the page is in.',
        'Use insert_content to add lines before/after a heading or landmark, or replace_lines for precise line-range edits.',
      ];
      if (hasAny(availableTools, ['copy_content'])) {
        parts.push('If the content already exists on another page or in a sandbox file, use copy_content instead of retyping it.');
      }
      return parts.join(' ');
    },
    skill: 'writing-documents',
  },
  {
    compose: (availableTools?: string[]) => {
      const base = '• CODE: Plain-text source code with syntax highlighting. Use replace_lines for edits (raw text, no HTML processing)';
      return hasAny(availableTools, ['copy_content'])
        ? `${base}, or copy_content to move a sandbox file in without retyping it.`
        : `${base}.`;
    },
  },
  {
    // Composed rather than picked from fixed variants. A bullet naming a tool
    // the agent does not hold produces an unknown-tool call before the model
    // recovers, and this bullet names up to three — read_sheet, read_page and
    // edit_sheet_cells. Gating only one of them left the other two able to do
    // exactly what the gate exists to prevent.
    compose: (availableTools?: string[]) => {
      const has = (tool: string) => hasAny(availableTools, [tool]);
      const parts = ['• SHEET: Spreadsheet stored as rows.'];
      if (has('read_sheet')) {
        parts.push('Use read_sheet to read a row range, look rows up by column value, or project columns — never page a whole sheet to search it.');
      } else if (has('read_page')) {
        parts.push('read_page returns its dimensions and a window of rows, and lineStart/lineEnd page it by ROW number.');
      }
      if (has('edit_sheet_cells')) {
        parts.push('Use edit_sheet_cells for cell-level edits.');
      }
      return parts.join(' ');
    },
    slimSuffix: 'load the spreadsheets skill before formulas or new sheets.',
    skill: 'spreadsheets',
  },
  {
    full: '• CANVAS: Raw HTML/CSS rendered in a sandboxed iframe. Author HTML renders into a real <body> — write standard HTML/CSS/JS. For uploaded FILE pages embedded in canvas HTML, use /dashboard/{driveId}/{filePageId}/view (not /api/files) so the same link works in unpublished iframes and can be rewritten for published canvases. For a signup/waitlist/contact form, call provision_form_target first — a hand-written <form> instead needs a human to finish wiring it to a Sheet in the page\'s Forms tab, since there\'s no tool for that step.',
    slim: '• CANVAS: Raw HTML/CSS/JS rendered in a sandboxed iframe. Load the canvas-websites skill before building or editing websites, embeds, or forms.',
    skill: 'canvas-websites',
  },
  {
    full: '• TASK_LIST: Task manager where each task auto-creates a linked child TASK_LIST page for its description and sub-tasks.',
    slim: '• TASK_LIST: Task manager. Load the task-management skill before task workflows.',
    skill: 'task-management',
  },
  { full: '• AI_CHAT: Custom AI agent with configurable system prompt and tool permissions.' },
  { full: '• CHANNEL: Team discussion thread with real-time messaging.' },
  { full: '• FILE: Uploaded file. Text-based files are readable via read_page.' },
];

/** Whether a builtin skill's pointer is actionable for this tool set. */
function skillPointerUsable(availableTools: string[] | undefined, trigger: string): boolean {
  if (availableTools === undefined || !availableTools.includes('load_skill')) return false;
  const definition = BUILTIN_SKILLS.find((skill) => skill.trigger === trigger);
  return definition !== undefined && isSkillEligible(definition, availableTools);
}

function buildPageTypes(availableTools?: string[]): string {
  const lines = PAGE_TYPE_BULLETS.map((bullet) => {
    const usesSkillPointer =
      Boolean(bullet.skill) && skillPointerUsable(availableTools, bullet.skill!);

    if (bullet.compose) {
      const composed = bullet.compose(availableTools);
      return usesSkillPointer && bullet.slimSuffix
        ? `${composed.replace(/\.$/, '')}; ${bullet.slimSuffix}`
        : composed;
    }
    return usesSkillPointer && bullet.slim ? bullet.slim : bullet.full;
  });

  return `PAGE TYPES:\n${lines.join('\n')}`;
}

const TASK_MANAGEMENT_FULL = `TASK MANAGEMENT:
• Read the task list with read_page before any mutations — inspect existing tasks, statuses, structure
• Tasks nest to any depth; a parent can't complete while direct subtasks remain open
• Use existing status slugs; only call create_task_status when no existing status fits
• For recurring task workflows, propose a trigger instead of asking the user to come back and ask again`;

const TASK_MANAGEMENT_WITH_SKILLS = `TASK MANAGEMENT:
• Read the task list with read_page before any mutations — inspect existing tasks, statuses, structure
• Tasks nest to any depth; a parent can't complete while direct subtasks remain open
• Load the task-management skill for statuses, assignees, triggers, and completion semantics`;

function buildTaskManagement(availableTools?: string[]): string {
  return skillPointerUsable(availableTools, 'task-management')
    ? TASK_MANAGEMENT_WITH_SKILLS
    : TASK_MANAGEMENT_FULL;
}

/**
 * AGENTS section. The base bullets apply whenever the section is included
 * (gated by includeAgents in buildInlineInstructions — buildGlobalAssistantInstructions
 * includes the section unconditionally). Two bullets name a capability beyond
 * that base gate — configuring a new specialist needs create_page AND
 * update_agent_config, not just spawn_session/list_agents; the list_models
 * bullet needs update_agent_config too (list_models alone only discovers
 * models, it doesn't apply one to an agent) — so they compose in only when
 * their own required tools are present, the same discipline buildPageTypes
 * uses for SHEET/DOCUMENT.
 */
function buildAgents(availableTools?: string[]): string {
  const has = (tool: string) => hasAny(availableTools, [tool]);
  const lines = [
    'AGENTS:',
    "• Discover available agents first — each has its own system prompt, tools, and expertise; list_agents reveals what's configured",
    "• Delegate with spawn_session (pass the agent's id as `agent`); send_session continues the same worker — save the sessionId from the spawn for follow-ups",
    '• The target agent does its own discovery and tool use — give it a clear question with context, not a pre-solved spec',
  ];
  if (has('create_page') && has('update_agent_config')) {
    lines.push('• For work that benefits from a dedicated, reusable specialist, configure a new AI_CHAT agent instead of always doing the job inline yourself');
  }
  if (has('list_models') && has('update_agent_config')) {
    lines.push('• Never guess a model ID when configuring an agent — call list_models first');
  }
  return lines.join('\n');
}

/**
 * AUTOMATION section. create_workflow/list_workflows alone only cover
 * recurring cron schedules — create_workflow's own description says one-off
 * or event-bound scheduling needs set_task_trigger/set_calendar_trigger
 * instead — so the "a one-off task... qualifies too" clause composes in
 * only when the agent can actually create that scheduling anchor itself,
 * the same discipline buildAgents uses for its own sub-bullets.
 *
 * Four tiers (codex review, four rounds of fresh evidence):
 * 1. Full one-off capability — set_calendar_trigger alone is sufficient (it
 *    creates a new "scheduling anchor" calendar event at the target time
 *    when none exists yet), or set_task_trigger + create_task + create_page
 *    together. create_page is required alongside create_task: create_task's
 *    `pageId` must name an EXISTING TASK_LIST page (task-management-tools.ts
 *    — "TASK_LIST page ID to add the task to") and create_task cannot create
 *    that host page itself — only create_page can, if the drive has no task
 *    list yet. update_task does NOT qualify here either: it requires an
 *    existing taskId ("taskId is required to update a task. To create a new
 *    task, use create_task.") — it cannot conjure a fresh anchor for a topic
 *    with no existing task, only create_task (+ a host page) can.
 * 2c. Conditional task-creation capability — set_task_trigger + create_task
 *    WITHOUT create_page: task creation only works if the drive already has
 *    a TASK_LIST page to add to, which the prompt can't know statically
 *    (that's drive content, not a tool permission) — hedge rather than
 *    promise, the same "static tool facts vs. runtime state" distinction
 *    applied to the send_shell+list_sessions case elsewhere in this file.
 * 2b. set_task_trigger + update_task (no create_task): update_task CAN set a
 *    due date on an EXISTING task (it just can't create a new one).
 * 2. Existing-task-only capability — set_task_trigger ALONE is NOT
 *    self-sufficient to create a new anchor from nothing (trigger-tools.ts:
 *    "The task must have a due date set before a due_date trigger can be
 *    attached. Set the task's due date first via update_task"), but it can
 *    still independently attach a completion trigger to ANY existing task,
 *    or a due-date trigger to one whose due date is ALREADY set — "run this
 *    when task X completes" is achievable without create_task at all.
 * 3. No one-off capability at all.
 */
function buildAutomation(availableTools?: string[]): string {
  const hasCalendarOneOffSetter = hasAny(availableTools, ['set_calendar_trigger']);
  const hasTaskTrigger = hasAny(availableTools, ['set_task_trigger']);
  const hasCreateTask = hasAny(availableTools, ['create_task']);
  const hasCreatePage = hasAny(availableTools, ['create_page']);
  const hasUpdateTask = hasAny(availableTools, ['update_task']);
  // codex review, fresh evidence: set_calendar_trigger's schema has no
  // recurrence field (attaches to an existing event, or creates ONE new
  // single-time "scheduling anchor" event) and set_task_trigger only fires
  // on a due date or completion — only create_workflow supports true
  // recurring cron schedules. "recurring work is the common case" was
  // asserted in every tier regardless, implying a capability that isn't
  // guaranteed present; only lead with it when create_workflow backs it up.
  const hasCreateWorkflow = hasAny(availableTools, ['create_workflow']);
  const recurringLeadIn = hasCreateWorkflow ? 'recurring work is the common case, but ' : '';

  let mainClause: string;
  if (hasCalendarOneOffSetter || (hasTaskTrigger && hasCreateTask && hasCreatePage)) {
    mainClause =
      `Propose a trigger whenever the work should happen without the user re-prompting — ${recurringLeadIn}a one-off task that needs to run at a future time or on some future event qualifies too`;
  } else if (hasTaskTrigger && hasCreateTask) {
    mainClause =
      `Propose a trigger whenever the work should happen without the user re-prompting — ${recurringLeadIn}for a one-off request, check whether the drive already has a task list to add a task to before assuming you can schedule it fresh (creating a new task list needs a separate capability)`;
  } else if (hasTaskTrigger && hasUpdateTask) {
    // codex review, fresh evidence: update_task CAN set a due date on an
    // existing task (it just can't create a new one from nothing) — the
    // tier-2 wording must say so, not just "a due date already set".
    mainClause =
      `Propose a trigger whenever the work should happen without the user re-prompting — ${recurringLeadIn}for a one-off or event-bound request, check whether it can attach to an existing task (on completion, a due date already set, or one you set via update_task) before assuming you can't schedule it`;
  } else if (hasTaskTrigger) {
    mainClause =
      `Propose a trigger whenever the work should happen without the user re-prompting — ${recurringLeadIn}for a one-off or event-bound request, check whether it can attach to an existing task (on completion, or a due date already set) before assuming you can't schedule it`;
  } else {
    // This branch only reaches when includeAutomation was true without any
    // calendar or task trigger tool — the only remaining possibility is
    // create_workflow, so "recurring" here is always backed.
    mainClause =
      "Propose a recurring trigger whenever work should repeat on a schedule without the user re-prompting — for a one-off or event-bound request, say that's outside what you can currently schedule rather than forcing it into a recurring one";
  }
  return `AUTOMATION:
• ${mainClause}
• Triggers require an existing AI_CHAT page in the same drive as the source (task/calendar/drive)
• After setting a trigger, tell the user what will run, when, and what the agent will receive as context`;
}

const SEARCH = `SEARCH:
• list_pages returns one level at a time (ls-style) — navigate with parentId to drill into folders; use recursive: true for a full subtree dump
• Escalate: list_pages (structure) → glob_search (name pattern) → regex_search (content) → multi_drive_search (location unknown)
• When a task needs domain expertise, check list_agents — a workspace agent may already know the answer better than a page search will
• Try at least two angles before declaring something not found; a single failed search is not "not found"
• For external knowledge or a user-provided URL: web_search to discover, web_fetch to read a specific page`;

const AFTER_TOOLS = `AFTER TOOLS:
Provide a brief summary of what was done. Suggest logical next steps when appropriate.`;

/** Guidance for the ask_user tool. Exported so the Global Assistant route (which
 * builds its own bespoke system prompt rather than calling buildInlineInstructions)
 * can append the identical wording instead of drifting. */
export const ASK_USER_SECTION = `ASKING THE USER:
• Ask when missing context would materially shape the result — not just because a detail would help a little
• Skip asking if the user's signaled they want autonomous work (e.g. "just do it," "don't check in with me," running unattended)
• Never ask something you could find out yourself by searching or reading the drive first
• 1-4 questions per call, 2-4 concise options each — the UI adds a free-text "Other" option automatically, don't add your own catch-all
• After calling ask_user, stop — do not call finish or any other tool in the same turn; it resumes when the user answers
• The result may be {"dismissed": true} — the user replied in chat instead of picking an option; treat their message as the answer`;

/**
 * MENTIONS section. This lives in the stable prompt, so it can't assume a
 * driveId is available this turn (that's turn-volatile LOCATION data,
 * injected separately — see location-prompt.ts) — always points the model
 * at how to resolve one instead of claiming it's already in context.
 */
function buildMentions(): string {
  return `MENTIONS:
When users @mention documents using @[Label](id:type) format, read them first with read_page before responding.
When writing content that should notify people:
• @[Name](userId:user) — notifies a specific user
• @[Role Name](roleId:role) — notifies all members with that role
• @[everyone](driveId:everyone) — notifies all drive members; use the driveId from your current LOCATION context if present, otherwise resolve via list_drives or from the resource you're working on`;
}

// ---------------------------------------------------------------------------
// Exported builders
// ---------------------------------------------------------------------------

/** Returns true if any of `toolNames` appears in `availableTools`, or if `availableTools` is undefined (include-all sentinel). */
function hasAny(availableTools: string[] | undefined, toolNames: string[]): boolean {
  if (!availableTools) return true;
  return toolNames.some(t => availableTools.includes(t));
}

/**
 * Build the inline instructions block for page context.
 *
 * Pass `availableTools` (the filtered tool name list) to omit sections for
 * capabilities the agent doesn't have. Omitting `availableTools` includes
 * all sections — used by the admin prompt viewer for a complete preview.
 *
 * Deliberately takes no location context — "current page"/"current drive"
 * is turn-volatile data injected separately via the volatile turn-context
 * block (location-prompt.ts), not baked in here.
 */
export function buildInlineInstructions(availableTools?: string[]): string {
  const includeTaskManagement = hasAny(availableTools, ['create_task', 'update_task', 'delete_task', 'create_task_status', 'reorder_task', 'get_assigned_tasks']);
  const includeAgents = hasAny(availableTools, ['spawn_session', 'list_agents', 'multi_drive_list_agents', 'update_agent_config', 'list_models']);
  // Deliberately excludes delete_task_trigger/delete_calendar_trigger/list_workflows:
  // those can only remove or list an existing trigger, not propose one — an agent
  // holding only those can't act on the "propose a trigger" instruction this
  // section exists to give.
  const includeAutomation = hasAny(availableTools, ['set_task_trigger', 'set_calendar_trigger', 'create_workflow']);
  const includeSearch = hasAny(availableTools, ['glob_search', 'regex_search', 'multi_drive_search', 'web_search', 'web_fetch']);
  const includeAskUser = hasAny(availableTools, ['ask_user']);

  const sections = [
    WORKSPACE_RULES,
    buildPageTypes(availableTools),
    includeTaskManagement ? buildTaskManagement(availableTools) : null,
    includeAgents ? buildAgents(availableTools) : null,
    includeAutomation ? buildAutomation(availableTools) : null,
    includeSearch ? SEARCH : null,
    includeAskUser ? ASK_USER_SECTION : null,
    AFTER_TOOLS,
    buildMentions(),
  ].filter(Boolean);

  return '\n' + sections.join('\n\n');
}

/**
 * Build inline instructions for the Global Assistant. Deliberately takes no
 * location context — see buildInlineInstructions above for why.
 *
 * Pass `availableTools` (the route's filtered tool names) so the page-type
 * and task sections slim to skill pointers when load_skill is present;
 * omitting it (admin prompt viewer) renders the full fallback text.
 */
export function buildGlobalAssistantInstructions(availableTools?: string[]): string {
  return `
${WORKSPACE_RULES}

${buildPageTypes(availableTools)}

${buildTaskManagement(availableTools)}

${buildAgents(availableTools)}

${buildAutomation(availableTools)}

${SEARCH}

${AFTER_TOOLS}

${buildMentions()}`;
}

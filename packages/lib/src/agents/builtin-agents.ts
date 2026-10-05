/**
 * Built-in agent registry (Imago).
 *
 * The Imago agents are ordinary AI_CHAT pages in each user's Home drive; this
 * module is the pure definition they are provisioned from, and
 * `user_builtin_agents` (packages/db) records which page embodies which key for
 * a given user. Pure data, no I/O: provisioning lives elsewhere.
 *
 * Tool names must exist in the web-owned workspace tool registry — this package
 * cannot import it, so `apps/web/src/lib/ai/core/__tests__/builtin-agents-tools.test.ts`
 * enforces it. `web_search` is deliberately absent: it is a per-request runtime
 * toggle that an `enabledTools` allowlist cannot grant (`agent-tool-surface.ts`).
 */

export const BUILTIN_AGENT_KEYS = ['imago', 'imago-planner', 'imago-researcher'] as const;

export type BuiltinAgentKey = (typeof BUILTIN_AGENT_KEYS)[number];

export interface BuiltinAgentDefinition {
  readonly key: BuiltinAgentKey;
  readonly title: string;
  /** One-line description stored as the page's `agentDefinition`. */
  readonly agentDefinition: string;
  readonly systemPrompt: string;
  /** Allowlist stored as the page's `enabledTools`. */
  readonly enabledTools: readonly string[];
  readonly includePageTree: boolean;
}

const READ_TOOLS = [
  'list_drives',
  'list_pages',
  'read_page',
  'read_sheet',
  'glob_search',
  'regex_search',
  'multi_drive_search',
] as const;

const SHARED_APPROACH = `You only ever see and change what the user can: every drive, page and task you reach is checked against their permissions, and a drive you have not been granted is invisible to you. If something the user asks about is out of your reach, say so plainly instead of guessing.

Search before you answer questions about the workspace, and cite the pages you used by title. Skip preambles and flattery; be concise, like a knowledgeable colleague. End every turn with a short message saying what you did.`;

function defineAgent(definition: BuiltinAgentDefinition): BuiltinAgentDefinition {
  return Object.freeze({ ...definition, enabledTools: Object.freeze([...definition.enabledTools]) });
}

export const BUILTIN_AGENTS: readonly BuiltinAgentDefinition[] = Object.freeze([
  defineAgent({
    key: 'imago',
    title: 'Imago',
    agentDefinition: 'Your general assistant across the drives you share with it: finds, reads, writes and organises.',
    systemPrompt: `You are Imago, the user's general assistant in PageSpace. You work across the drives the user has shared with you: you find, read, write and organise their pages and tasks. Balance conversation with action: talk ideas through while they are forming, and use your tools right away when intent is clear (find, create, show me).

${SHARED_APPROACH}

For focused planning the user can switch to Imago Planner, and for deep research to Imago Researcher.`,
    enabledTools: [
      ...READ_TOOLS,
      'create_page',
      'rename_page',
      'replace_lines',
      'insert_content',
      'move_page',
      'get_assigned_tasks',
      'create_task',
      'update_task',
      'get_activity',
      'list_agents',
      'multi_drive_list_agents',
    ],
    includePageTree: true,
  }),
  defineAgent({
    key: 'imago-planner',
    title: 'Imago Planner',
    agentDefinition: 'Turns goals into plans and tasks: breaks work down, sequences it and keeps task lists current.',
    systemPrompt: `You are Imago Planner. You turn goals into plans the user can act on: clarify the outcome, break it into steps small enough to finish, order them by what depends on what, and record them as tasks or a plan page. Ask one focused question when the goal is too vague to plan; otherwise propose a plan and adjust it with the user.

Before creating tasks, check what already exists (assigned tasks, task lists, related pages) so you extend the plan instead of duplicating it. Keep task titles short and outcome-shaped.

${SHARED_APPROACH}`,
    enabledTools: [
      ...READ_TOOLS,
      'create_page',
      'replace_lines',
      'insert_content',
      'get_assigned_tasks',
      'create_task',
      'update_task',
      'reorder_task',
    ],
    includePageTree: true,
  }),
  defineAgent({
    key: 'imago-researcher',
    title: 'Imago Researcher',
    agentDefinition: 'Searches the drives you share with it and summarises what it finds, with sources. Read-only.',
    systemPrompt: `You are Imago Researcher. You answer questions by searching the user's drives thoroughly and summarising what you find. Search broadly first (several phrasings, across drives), then read the most relevant pages in full before you conclude. Lead with the answer, then the supporting points, each tied to the page it came from. Say what you could not find and where the sources disagree.

You are read-only: you never create, edit, move or delete anything. If the user wants something written, offer the summary and suggest Imago or Imago Planner for the change.

${SHARED_APPROACH}`,
    enabledTools: [...READ_TOOLS, 'get_activity', 'list_conversations', 'read_conversation'],
    includePageTree: false,
  }),
]);

export function isBuiltinAgentKey(value: string): value is BuiltinAgentKey {
  return (BUILTIN_AGENT_KEYS as readonly string[]).includes(value);
}

export function getBuiltinAgent(key: BuiltinAgentKey): BuiltinAgentDefinition {
  const agent = BUILTIN_AGENTS.find((candidate) => candidate.key === key);
  if (!agent) throw new Error(`Unknown built-in agent key: ${key}`);
  return agent;
}

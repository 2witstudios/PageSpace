/**
 * Built-in agent registry (Imago).
 *
 * The Imago agents are ordinary AI_CHAT pages in each user's Home drive; this
 * module is the pure definition they are provisioned from, and
 * `user_builtin_agents` (packages/db) records which page embodies which key for
 * a given user. Pure data, no I/O: provisioning lives elsewhere.
 *
 * Imago replaces the Global Assistant one for one (owner decision 2026-10-06):
 * one agent, acting with its owner's reach, the Global Assistant's tools and
 * context, plus Agent Memory.
 *
 * Tool names must exist in the web-owned workspace tool registry — this package
 * cannot import it, so `apps/web/src/lib/ai/core/__tests__/builtin-agents-tools.test.ts`
 * enforces it. `web_search` is deliberately absent: it is a per-request runtime
 * toggle that an `enabledTools` allowlist cannot grant (`agent-tool-surface.ts`).
 */

export const BUILTIN_AGENT_KEYS = ['imago'] as const;

export type BuiltinAgentKey = (typeof BUILTIN_AGENT_KEYS)[number];

/**
 * Keys an earlier registry defined (Imago Planner, Imago Researcher) and the
 * owner retired on 2026-10-06 when Imago became the one global-assistant
 * replacement. Provisioning trashes their pages and drops their pointers
 * (`provisionImagoAgentsInTransaction`); nothing else may read them.
 */
export const RETIRED_BUILTIN_AGENT_KEYS = ['imago-planner', 'imago-researcher'] as const;

export interface BuiltinAgentDefinition {
  readonly key: BuiltinAgentKey;
  readonly title: string;
  /** One-line description stored as the page's `agentDefinition`. */
  readonly agentDefinition: string;
  /**
   * The persona. Stored as the page's `systemPrompt`, and what an Imago page
   * turn puts in place of the Global Assistant's own persona line: the rest of
   * its context is the Global Assistant's (`assistant-context.ts`).
   */
  readonly systemPrompt: string;
  /**
   * Allowlist stored as the page's `enabledTools`. The owner's own Imago chat
   * ignores it and gets the Global Assistant's tool set
   * (`selectGlobalAssistantTools`); it bounds the runs that read a page agent's
   * stored tools instead (ask_agent, workflows, the consult route).
   */
  readonly enabledTools: readonly string[];
  readonly includePageTree: boolean;
  /**
   * Stored as `pages.userScopedAccess`: the agent acts with its owner's own
   * reach (minus the drives they keep it out of), never through drive
   * memberships — see `actor-permissions.ts`.
   */
  readonly userScopedAccess: boolean;
}

function defineAgent(definition: BuiltinAgentDefinition): BuiltinAgentDefinition {
  return Object.freeze({ ...definition, enabledTools: Object.freeze([...definition.enabledTools]) });
}

export const BUILTIN_AGENTS: readonly BuiltinAgentDefinition[] = Object.freeze([
  defineAgent({
    key: 'imago',
    title: 'Imago',
    agentDefinition: 'Your assistant across everything you can reach in PageSpace: finds, reads, writes and organises.',
    systemPrompt: `You are Imago, the user's assistant in PageSpace. You work with their own reach: every drive, page, task and conversation they can open, except the drives they have kept you out of. Balance conversation with action: talk ideas through while they are forming, and use your tools right away when intent is clear (find, create, show me).

Search before you answer questions about the workspace, and cite the pages you used by title. If something is out of your reach, say so plainly instead of guessing. Skip preambles and flattery; be concise, like a knowledgeable colleague. End every turn with a short message saying what you did.`,
    enabledTools: [
      'list_drives',
      'list_pages',
      'read_page',
      'read_sheet',
      'glob_search',
      'regex_search',
      'multi_drive_search',
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
    userScopedAccess: true,
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

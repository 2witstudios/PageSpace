/**
 * Universal Commands — core validation, registry, and precedence resolution.
 *
 * A command implements the Agent Skills open standard (agentskills.io): the
 * entry page is the SKILL.md (eagerly injected at execution) and its direct
 * child pages are the discoverable resources. This module is pure (no I/O) so
 * both the API routes and future UI/context-engine consumers share one source
 * of truth.
 */

/** Where a command lives. Collision precedence: builtin > user > drive. */
export type CommandScope = 'builtin' | 'user' | 'drive';

/**
 * v1 ships 'document' only; 'prompt_template' and 'builtin' are reserved for
 * later phases.
 */
export type CommandType = 'document' | 'prompt_template' | 'builtin';

export interface CommandSummary {
  id: string;
  trigger: string;
  description: string;
  scope: CommandScope;
  type: CommandType;
  entryPageId?: string;
  driveId?: string;
  enabled?: boolean;
  /** Set on a precedence winner that hides a lower-precedence command. */
  shadows?: CommandScope;
}

/**
 * Data injected into a built-in's dynamic prompt section. The resolver layer
 * loads it (DB queries, permission checks) and hands it to the pure builder —
 * the registry itself never performs I/O.
 */
export interface BuiltinPromptContext {
  /**
   * The sender's precedence-resolved command list for the current context:
   * built-ins + personal commands + (when there is a drive context the
   * sender is a member of) that drive's commands.
   */
  availableCommands: readonly CommandSummary[];
}

export interface BuiltinCommandDefinition {
  trigger: string;
  description: string;
  /**
   * Optional dynamic prompt section: a pure function of injected data (data
   * in, string out). When present, the resolver loads a BuiltinPromptContext
   * and injects this builder's output instead of the bare description; when
   * loading fails it degrades to the static description.
   */
  buildPromptSection?: (context: BuiltinPromptContext) => string;
}

/** User-facing scope names ('user' is presented as 'personal'). */
const SCOPE_LABELS: Record<CommandScope, string> = {
  builtin: 'built-in',
  user: 'personal',
  drive: 'drive',
};

/**
 * The /help dynamic section: the sender's actual command list plus a short
 * explanation of the command mechanics, so the AI can answer "what commands
 * do I have here?" with real data instead of guessing.
 */
export function buildHelpPromptSection(context: BuiltinPromptContext): string {
  const lines: string[] = [
    'The user asked for help with slash commands. Commands work like this: the user picks a command from the picker that opens when they type "/" in the message box, which inserts a command chip at the start of the message. When the message is sent, the command\'s entry page (its instructions) is injected into the assistant\'s context, and the entry page\'s direct child pages become resources the assistant reads on demand with the read_page tool. Built-in commands have no entry page; their description is the instruction. Personal commands are visible only to their owner, drive commands are shared with every member of the drive, and when triggers collide the precedence is built-in over personal over drive.',
    '',
  ];

  if (context.availableCommands.length === 0) {
    lines.push('No commands are available in this context.');
  } else {
    lines.push('These are the commands actually available to the user here:', '');
    for (const command of context.availableCommands) {
      lines.push(`- /${command.trigger} (${SCOPE_LABELS[command.scope]}) — ${command.description}`);
    }
  }

  lines.push(
    '',
    'Answer the user\'s question using this list — present the available commands with what each does, and briefly explain how to invoke one. Do not invent commands that are not listed.'
  );

  return lines.join('\n');
}

/**
 * Built-in command registry. Built-ins with a `buildPromptSection` get a
 * dynamic section injected at execution (phase 5); the rest inject their
 * static description.
 */
export const BUILTIN_COMMANDS: readonly BuiltinCommandDefinition[] = [
  {
    trigger: 'help',
    description: 'List the commands available here and explain how to use them.',
    buildPromptSection: buildHelpPromptSection,
  },
];

/**
 * Triggers that user/drive commands may never claim. Creation with a reserved
 * trigger is rejected outright (built-ins always win collisions anyway).
 */
export const RESERVED_TRIGGERS: ReadonlySet<string> = new Set(
  BUILTIN_COMMANDS.map((command) => command.trigger)
);

export function isReservedTrigger(trigger: string): boolean {
  return RESERVED_TRIGGERS.has(trigger);
}

/** Agent Skills 'name' rules: lowercase alphanumeric + single hyphens. */
export const COMMAND_TRIGGER_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const COMMAND_TRIGGER_MAX_LENGTH = 64;
export const COMMAND_DESCRIPTION_MAX_LENGTH = 1024;

export type CommandValidationResult = { valid: true } | { valid: false; error: string };

/**
 * Validate a command trigger against the Agent Skills 'name' rules: 1-64
 * chars, lowercase alphanumeric and hyphens only, no leading/trailing/
 * consecutive hyphens.
 */
export function validateCommandTrigger(trigger: unknown): CommandValidationResult {
  if (typeof trigger !== 'string') {
    return { valid: false, error: 'Trigger must be a string' };
  }
  if (trigger.length === 0) {
    return { valid: false, error: 'Trigger must not be empty' };
  }
  if (trigger.length > COMMAND_TRIGGER_MAX_LENGTH) {
    return {
      valid: false,
      error: `Trigger must be ${COMMAND_TRIGGER_MAX_LENGTH} characters or less`,
    };
  }
  if (!COMMAND_TRIGGER_PATTERN.test(trigger)) {
    return {
      valid: false,
      error:
        'Trigger must be lowercase letters, numbers, and hyphens, with no leading, trailing, or consecutive hyphens',
    };
  }
  return { valid: true };
}

/**
 * Validate a command description: required, 1-1024 chars (Agent Skills spec).
 * Write it as "what it does + when to use it".
 */
export function validateCommandDescription(description: unknown): CommandValidationResult {
  if (typeof description !== 'string') {
    return { valid: false, error: 'Description must be a string' };
  }
  if (description.trim().length === 0) {
    return { valid: false, error: 'Description must not be empty' };
  }
  if (description.length > COMMAND_DESCRIPTION_MAX_LENGTH) {
    return {
      valid: false,
      error: `Description must be ${COMMAND_DESCRIPTION_MAX_LENGTH} characters or less`,
    };
  }
  return { valid: true };
}

export interface ResolvedCommands {
  /** One command per trigger, highest precedence wins, ordered builtin > user > drive. */
  winners: CommandSummary[];
  /** Commands hidden by a higher-precedence command with the same trigger. */
  shadowed: CommandSummary[];
}

/**
 * Merge built-in, user, and drive commands into a single suggestion list.
 * For each trigger the highest-precedence command wins; winners that hide a
 * lower-precedence command carry `shadows` with the hidden command's scope.
 */
export function resolveCommandPrecedence(
  builtins: readonly CommandSummary[],
  userCommands: readonly CommandSummary[],
  driveCommands: readonly CommandSummary[]
): ResolvedCommands {
  const winners: CommandSummary[] = [];
  const shadowed: CommandSummary[] = [];
  const winnerByTrigger = new Map<string, CommandSummary>();

  for (const tier of [builtins, userCommands, driveCommands]) {
    for (const command of tier) {
      const winner = winnerByTrigger.get(command.trigger);
      if (winner) {
        if (winner.shadows === undefined) {
          winner.shadows = command.scope;
        }
        shadowed.push({ ...command });
      } else {
        const copy = { ...command };
        winnerByTrigger.set(command.trigger, copy);
        winners.push(copy);
      }
    }
  }

  return { winners, shadowed };
}

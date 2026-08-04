/**
 * Command Processor for AI Chat System (Universal Commands)
 *
 * Pure core for executing a slash command attached to a user message.
 * A command implements the Agent Skills standard: its entry page is the
 * skill body (eagerly injected into the system prompt when the command
 * runs) and the entry page's direct children are discoverable resources
 * the AI reads on demand with read_page.
 *
 * This module is pure (no I/O): parsing the command token out of message
 * content, mapping a resolved execution plan to a system-prompt section,
 * and mapping the plan to the execution-feedback payload streamed to the
 * client. The DB/permission resolution that produces the plan lives in
 * command-resolver.ts.
 */

import {
  parseMessageTokens,
  COMMAND_TOKEN_TYPE,
} from '@/lib/tokens/message-tokens';
import { COMMAND_TRIGGER_PATTERN, builtinCommandId } from '@pagespace/lib/commands/command-core';

/**
 * A token label is echoed into the system prompt only when it looks like a
 * real trigger. The token grammar admits almost arbitrary text (including
 * newlines), and a skipped command's label is client-controlled — echoing
 * it verbatim would promote message text into the system role.
 */
function safeCommandLabel(label: string): string | null {
  return COMMAND_TRIGGER_PATTERN.test(label) ? label : null;
}

export interface ParsedCommandToken {
  commandId: string;
  label: string;
}

/**
 * Find every active command token in a message, in document order. Chip
 * validity is set at insertion, not send time — users may prepend text (or
 * mentions) before, between, or after chips and every chip still applies to
 * the whole message (UX spec §2.3). Multiple commands per message are
 * supported: each resolves independently (see command-resolver.ts). A
 * repeated identical commandId is deduplicated, keeping the first
 * occurrence — commands carry no arguments, so resolving the same command
 * twice would inject byte-identical instructions for no benefit.
 *
 * Reuses the canonical token grammar from message-tokens, which already
 * rejects mismatched sigil/type pairs — only the exact
 * `/[Label](commandId:command)` serialization is a command.
 */
export function findActiveCommandTokens(content: string): ParsedCommandToken[] {
  if (!content) return [];
  const { tokens } = parseMessageTokens(content);
  const seen = new Set<string>();
  const result: ParsedCommandToken[] = [];
  for (const token of tokens) {
    if (token.type !== COMMAND_TOKEN_TYPE) continue;
    if (seen.has(token.id)) continue;
    seen.add(token.id);
    result.push({ commandId: token.id, label: token.label });
  }
  return result;
}

/**
 * Whether `content` is nothing but a single built-in command chip for
 * `trigger` — no other text before, after, or between. Used to detect a
 * "solo" invocation (e.g. a bare `/help`) that can be answered directly from
 * code instead of going through the model: a chip combined with real text
 * (`/help how do I use spreadsheets`) is a genuine question and stays on the
 * LLM path.
 *
 * Pure — reuses parseMessageTokens instead of re-deriving token positions.
 */
export function isSoloBuiltinCommand(content: string, trigger: string): boolean {
  const { displayText, tokens } = parseMessageTokens(content);
  if (tokens.length !== 1) return false;
  const [token] = tokens;
  if (token.type !== COMMAND_TOKEN_TYPE || token.id !== builtinCommandId(trigger)) return false;
  const withoutToken = displayText.slice(0, token.start) + displayText.slice(token.end);
  return withoutToken.trim().length === 0;
}

/** Why a command was skipped instead of injected (UX spec §7.2). */
export type CommandSkipReason = 'page_trashed' | 'no_access' | 'not_found' | 'disabled';

/** Exact spec §7.2 reason copy, shared by the AI notice and the client pill. */
export const COMMAND_SKIP_REASON_TEXT: Record<CommandSkipReason, string> = {
  page_trashed: 'its page is in the trash',
  no_access: 'you no longer have access to its page',
  not_found: 'the command no longer exists',
  disabled: 'the command is disabled',
};

/** "Skipped /foo — {reason}" — the visible skip notice (UX spec §7.2). */
export function commandSkipNoticeText(label: string, reason: CommandSkipReason): string {
  return `Skipped /${label} — ${COMMAND_SKIP_REASON_TEXT[reason]}`;
}

export interface CommandChildResource {
  id: string;
  title: string;
  type: string;
}

export interface CommandInjection {
  commandId: string;
  trigger: string;
  label: string;
  scope: 'builtin' | 'user' | 'drive';
  description: string;
  /**
   * The serialized entry page (skill body). Null for built-in commands,
   * which have no entry page — their description is the instruction.
   */
  entryPage: {
    id: string;
    title: string;
    type: string;
    serializedContent: string;
  } | null;
  /** Direct, non-trashed children the sender can view — the resource manifest. */
  children: CommandChildResource[];
  /**
   * Resolved dynamic section for a built-in command (e.g. /help's actual
   * command list). Built by the registry's pure buildPromptSection from data
   * the resolver loaded; absent for page-backed commands and when loading
   * failed (the static description is the fallback instruction).
   */
  dynamicContent?: string;
}

export type CommandExecutionPlan =
  | { kind: 'inject'; injection: CommandInjection }
  | { kind: 'skip'; commandId: string; label: string; reason: CommandSkipReason };

/**
 * Entry-page size is advisory at authoring time (~5k tokens), so commands
 * inject in full — this cap only guards pathological cases (UX spec §7.2),
 * with a truncation notice pointing the AI at read_page for the rest.
 */
export const COMMAND_CONTENT_CHAR_LIMIT = 60_000;

/**
 * Build the system-prompt section for an injected command: the entry page
 * content (the skill body) plus a manifest of its direct children as
 * on-demand resources. Children are never bulk-injected.
 */
export function buildCommandSystemPrompt(injection: CommandInjection): string {
  const lines: string[] = [
    '',
    `## COMMAND: /${injection.trigger}`,
    '',
    `The user invoked the /${injection.trigger} command (${injection.description}).`,
  ];

  if (injection.entryPage) {
    let content = injection.entryPage.serializedContent;
    let truncationNote = '';
    if (content.length > COMMAND_CONTENT_CHAR_LIMIT) {
      content = content.slice(0, COMMAND_CONTENT_CHAR_LIMIT);
      truncationNote = `\n\n[Content truncated — the page is unusually large. Use read_page with pageId "${injection.entryPage.id}" to read the rest on demand.]`;
    }
    lines.push(
      `Follow the instructions in its page "${injection.entryPage.title}" (pageId: ${injection.entryPage.id}) below:`,
      '',
      '<command_instructions>',
      content + truncationNote,
      '</command_instructions>'
    );
  } else if (injection.dynamicContent) {
    lines.push(injection.dynamicContent);
  } else {
    lines.push('Act according to that description.');
  }

  if (injection.children.length > 0) {
    lines.push(
      '',
      `The command provides these resources (direct child pages of "${injection.entryPage?.title ?? injection.trigger}"). They are NOT loaded; read any of them on demand with the read_page tool when relevant:`,
      ...injection.children.map((child) => `- "${child.title}" (pageId: ${child.id})`)
    );
  }

  // Chip injections ride the volatile turn context — they exist only for
  // the request that carried the chip and are absent from later turns'
  // history. The re-load pointer keeps multi-turn work restorable, exactly
  // like the elision stub on the load_skill path.
  lines.push(
    '',
    `These instructions apply to this turn only. If later turns continue this work and they are no longer in context, call load_skill("${injection.trigger}") to restore them.`
  );

  return lines.join('\n') + '\n';
}

/**
 * Build the load_skill tool-result payload for an injected command/skill —
 * the model-initiated twin of buildCommandSystemPrompt (chip path). Same
 * body, same 60k truncation contract, same listed-not-loaded child manifest,
 * but framed as instructions to follow rather than "the user invoked":
 * tool results are weighted as information by default, so the framing is
 * load-bearing, not decoration.
 */
export function buildSkillLoadResult(injection: CommandInjection): string {
  const lines: string[] = [`<skill_instructions name="${injection.trigger}">`];

  if (injection.entryPage) {
    let content = injection.entryPage.serializedContent;
    if (content.length > COMMAND_CONTENT_CHAR_LIMIT) {
      content =
        content.slice(0, COMMAND_CONTENT_CHAR_LIMIT) +
        `\n\n[Content truncated — the page is unusually large. Use read_page with pageId "${injection.entryPage.id}" to read the rest on demand.]`;
    }
    lines.push(content);
  } else if (injection.dynamicContent) {
    lines.push(injection.dynamicContent);
  } else {
    lines.push(injection.description);
  }

  lines.push('</skill_instructions>');
  lines.push(
    '',
    `Follow these instructions for the current task. If this load is later elided from the conversation, call load_skill("${injection.trigger}") again to restore it.`
  );

  if (injection.children.length > 0) {
    lines.push(
      '',
      'This skill provides these resources. They are NOT loaded; read any of them on demand with the read_page tool when relevant:',
      ...injection.children.map((child) => `- "${child.title}" (pageId: ${child.id})`)
    );
  }

  return lines.join('\n');
}

/**
 * Map a single resolved plan to its section of the system prompt: a skipped
 * command contributes a one-line notice so the AI can acknowledge it without
 * treating it as an error (spec §7.2: the response itself proceeds
 * normally); an injected command contributes its full labeled block.
 */
function buildSinglePlanSection(plan: CommandExecutionPlan): string {
  if (plan.kind === 'skip') {
    const safe = safeCommandLabel(plan.label);
    const name = safe ? `the /${safe} command` : 'a slash command';
    return `\nNote: the user invoked ${name}, but it was skipped because ${COMMAND_SKIP_REASON_TEXT[plan.reason]}. Respond to the message text normally.\n`;
  }
  return buildCommandSystemPrompt(plan.injection);
}

/**
 * Map every resolved plan from a message (one per command chip, in document
 * order — see findActiveCommandTokens/planCommandExecutions) to the section
 * joined into the system prompt. An empty array (no command in the message)
 * contributes nothing. Each plan's section is self-contained (its own
 * `## COMMAND: /trigger` heading and resource manifest, or its own skip
 * notice), so multiple commands' instructions land in the same turn without
 * their resources being confused for one another.
 */
export function buildCommandPromptSection(plans: CommandExecutionPlan[]): string {
  return plans.map(buildSinglePlanSection).join('');
}

/**
 * Execution-feedback payload streamed to (and persisted for) the client as
 * a `data-command-execution` message part — drives the "Using /foo" /
 * "Skipped /foo — {reason}" indicator (UX spec §7).
 */
export const COMMAND_EXECUTION_PART_TYPE = 'data-command-execution' as const;

export interface CommandExecutionData {
  label: string;
  status: 'used' | 'skipped';
  reason?: CommandSkipReason;
  entryPageTitle?: string;
}

export function commandExecutionDataFromPlan(plan: CommandExecutionPlan): CommandExecutionData {
  if (plan.kind === 'skip') {
    return { label: plan.label, status: 'skipped', reason: plan.reason };
  }
  return {
    label: plan.injection.trigger,
    status: 'used',
    ...(plan.injection.entryPage ? { entryPageTitle: plan.injection.entryPage.title } : {}),
  };
}

/**
 * Command Processor for AI Chat System (Universal Commands phase 4)
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
import { COMMAND_TRIGGER_PATTERN } from '@pagespace/lib/commands/command-core';

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
 * Find the active command token in a message: the first command-type token
 * in document order. Chip validity is set at insertion, not send time —
 * users may prepend text (or mentions) before the chip and the command
 * still applies to the whole message (UX spec §2.3). Any later command
 * tokens are ignored: one command per message.
 *
 * Reuses the canonical token grammar from message-tokens, which already
 * rejects mismatched sigil/type pairs — only the exact
 * `/[Label](commandId:command)` serialization is a command.
 */
export function findActiveCommandToken(content: string): ParsedCommandToken | null {
  if (!content) return null;
  const { tokens } = parseMessageTokens(content);
  const command = tokens.find((token) => token.type === COMMAND_TOKEN_TYPE);
  if (!command) return null;
  return { commandId: command.id, label: command.label };
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

  return lines.join('\n') + '\n';
}

/**
 * Map a resolved plan to the section joined into the system prompt.
 * Null (no command in the message) contributes nothing; a skipped command
 * contributes a one-line notice so the AI can acknowledge it without
 * treating it as an error (spec §7.2: the response itself proceeds
 * normally).
 */
export function buildCommandPromptSection(plan: CommandExecutionPlan | null): string {
  if (!plan) return '';
  if (plan.kind === 'skip') {
    const safe = safeCommandLabel(plan.label);
    const name = safe ? `the /${safe} command` : 'a slash command';
    return `\nNote: the user invoked ${name}, but it was skipped because ${COMMAND_SKIP_REASON_TEXT[plan.reason]}. Respond to the message text normally.\n`;
  }
  return buildCommandSystemPrompt(plan.injection);
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

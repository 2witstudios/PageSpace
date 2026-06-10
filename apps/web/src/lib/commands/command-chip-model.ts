/**
 * Pure render model for command chips in transcripts (UX spec §5, §6).
 *
 * Maps a parsed command token (its stored label survives even when the
 * command is gone) plus the viewer-scoped resolution from
 * GET /api/commands/resolve into everything the chip component renders.
 * Kept pure so the spec's degraded states are testable without React.
 */

export type CommandChipScope = 'builtin' | 'user' | 'drive';

export type CommandChipResolution =
  /** Resolution request in flight — render a plain, non-navigable chip. */
  | { state: 'loading' }
  /** The command registration was deleted after the message was sent (§5.2). */
  | { state: 'deleted' }
  /** The command exists but the viewer may not see its metadata (e.g. someone else's personal command in a shared channel). */
  | { state: 'restricted' }
  | {
      state: 'ok';
      trigger: string;
      description: string;
      scope: CommandChipScope;
      enabled: boolean;
      entryPageId?: string;
      entryPageTrashed: boolean;
      viewerCanViewEntryPage: boolean;
    };

export interface CommandChipViewModel {
  /** Display text: the serialized label with the leading slash. */
  text: string;
  /** Muted (unavailable) visual treatment: bg-muted text-muted-foreground. */
  muted: boolean;
  /** Whether clicking navigates to the entry page. */
  navigable: boolean;
  /** Entry page href when navigable. */
  href?: string;
  /** Tooltip lines, in display order. */
  tooltip: string[];
}

const SCOPE_LINE: Record<CommandChipScope, string> = {
  user: 'Personal command',
  drive: 'Drive command',
  builtin: 'Built-in command',
};

export interface CommandChipOptions {
  /**
   * The chip sits in a conversation with no AI participant, so sending it
   * ran nothing (§6) — adds the inert tooltip suffix.
   */
  inertNoAI?: boolean;
}

export function buildCommandChipViewModel(
  label: string,
  resolution: CommandChipResolution,
  options: CommandChipOptions = {}
): CommandChipViewModel {
  const text = `/${label}`;
  const tooltip: string[] = [];
  let muted = false;
  let navigable = false;
  let href: string | undefined;

  switch (resolution.state) {
    case 'loading':
      tooltip.push(text);
      break;
    case 'deleted':
      muted = true;
      tooltip.push(text, 'This command no longer exists.');
      break;
    case 'restricted':
      tooltip.push(text, 'Command');
      break;
    case 'ok': {
      tooltip.push(`/${resolution.trigger} — ${resolution.description}`, SCOPE_LINE[resolution.scope]);
      if (resolution.entryPageTrashed) {
        // Unavailable treatment of §5.2 with the trash tooltip (§5.3).
        muted = true;
        tooltip.push("This command's page is in the trash.");
      } else if (!resolution.viewerCanViewEntryPage) {
        tooltip.push("You don't have access to this command's page.");
      } else if (resolution.entryPageId) {
        navigable = true;
        href = `/p/${resolution.entryPageId}`;
      }
      if (!resolution.enabled) {
        // Disabled affects new executions, not historical rendering (§5.2).
        tooltip.push('This command is currently disabled.');
      }
      break;
    }
  }

  if (options.inertNoAI) {
    tooltip.push("No AI is in this conversation, so this command didn't run.");
  }

  return { text, muted, navigable, ...(href ? { href } : {}), tooltip };
}

/**
 * Whether a channel/DM message's command chip ran nothing (UX spec §6).
 * Agents respond only to @-mentions, so a chip-bearing message that pings
 * no page (agent) is inert; AI-authored messages never execute chips.
 */
const PAGE_MENTION_PATTERN = /@\[[^\]]+\]\([^()]+:page\)/;
export function isCommandInertForMessage(content: string, isAiMessage: boolean): boolean {
  return !isAiMessage && !PAGE_MENTION_PATTERN.test(content);
}

/**
 * RichText preprocessing: rewrite the LEADING command token (first in
 * document order — one command per message) into an internal markdown link
 * the custom anchor renders as a chip, parallel to preprocessMentions.
 * The id/type split is on the last colon so built-in ids (`builtin:help`)
 * survive. Any later command-shaped text stays literal — it was never a
 * chip (§2.3: only picker selection creates one).
 */
export function preprocessCommandTokens(content: string): string {
  // Non-global regex: .replace converts only the first match.
  return content.replace(
    /\/\[([^\]]+)\]\(([^()]+):command\)/,
    (_match, label: string, id: string) => `[command:${label}](/command/${id})`
  );
}

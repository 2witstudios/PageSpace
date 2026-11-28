import type { ToolCallState } from './tool-summary';

/** A tool call: one compact, muted disclosure in the reply's flow. */
export const toolSummaryClass = 'group min-w-0 text-xs text-ink-muted';

/** The one line: icon, name, target and state; the marker is the chevron. */
export const toolSummaryLineClass =
  'flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-overlay hover:text-ink';

/** What the call acted on: it gives way first when the line is short. */
export const toolTargetClass = 'min-w-0 flex-1 truncate text-ink-faint';

const stateTones: Readonly<Record<ToolCallState, string>> = {
  running: 'text-accent',
  done: 'text-ink-faint',
  failed: 'text-warn',
  denied: 'text-ink-faint',
};

export const toolStateClass = (state: ToolCallState): string => `flex-none ${stateTones[state]}`;

/** The input and output once expanded, as text in a sunken block. */
export const toolDetailClass =
  'mt-1 ml-6 overflow-x-auto rounded-md bg-surface-sunken p-2 font-mono text-2xs whitespace-pre-wrap text-ink-muted';

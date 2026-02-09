import type { ToolUIPart } from 'ai';

// Forward-compatible states — remove when upgrading to AI SDK v6
export type ExtendedToolState =
  | ToolUIPart['state']
  | 'approval-requested'
  | 'approval-responded'
  | 'output-denied';

// One tool call as the chat shows it: a single line naming the call, what it
// acted on and where it is, with its input and output behind it. The parts
// are the AI SDK's, exactly as the server stored or streamed them.

import { getToolName, type DynamicToolUIPart, type ToolUIPart } from 'ai';

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolCallState = 'running' | 'done' | 'failed' | 'denied';

export type ToolCallSummary = {
  readonly id: string;
  /** The tool's name in sentence case: read_page → Read page. */
  readonly name: string;
  /** What the call acted on, when its input names it readably. */
  readonly target: string | null;
  readonly state: ToolCallState;
  /** Pretty JSON for the expanded view; null until there is any. */
  readonly input: string | null;
  /** The result, or the error of a failed call. */
  readonly output: string | null;
};

/** The longest input or output the expanded view shows. */
export const DETAIL_LIMIT = 2000;

export const toolLabel = (name: string): string => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase())
    .join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const states: Readonly<Record<ToolPart['state'], ToolCallState>> = {
  'input-streaming': 'running',
  'input-available': 'running',
  'approval-requested': 'running',
  'approval-responded': 'running',
  'output-available': 'done',
  'output-error': 'failed',
  'output-denied': 'denied',
};

/** Input fields that name what a call acts on, most telling first. */
const targetFields = ['title', 'name', 'query', 'path', 'url'] as const;

const targetOf = (input: unknown): string | null => {
  if (typeof input !== 'object' || input === null) return null;
  const fields = input as Readonly<Record<string, unknown>>;
  for (const field of targetFields) {
    const value = fields[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
};

const cut = (text: string): string => (text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text);

const detail = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (typeof value === 'string') return cut(value);
  const json = JSON.stringify(value, null, 2) as string | undefined;
  return json === undefined ? null : cut(json);
};

export const toolSummary = (part: ToolPart): ToolCallSummary => ({
  id: part.toolCallId,
  name: toolLabel(getToolName(part)),
  target: targetOf(part.input),
  state: states[part.state],
  input: detail(part.input),
  output: part.state === 'output-error' ? cut(part.errorText) : part.state === 'output-available' ? detail(part.output) : null,
});

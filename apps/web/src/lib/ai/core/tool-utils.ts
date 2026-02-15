import type { ToolSet } from 'ai';

export function mergeToolSets(base: ToolSet, additional: Record<string, unknown>): ToolSet {
  return { ...base, ...additional } as ToolSet;
}

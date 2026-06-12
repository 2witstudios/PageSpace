/**
 * Per-feature attribution tag for AI usage.
 *
 * Every AI call that spends credits records WHICH feature spent them, so a user can
 * see "where my tokens go" on the usage page. This is the canonical, closed set —
 * stamped at each `AIMonitoring.trackUsage(...)` call site and grouped by the
 * usage-breakdown query. Pure module: no I/O, safe to import anywhere.
 */

export const USAGE_SOURCES = [
  'chat',
  'page_agent',
  'pulse',
  'memory',
  'voice',
  'workflow',
  'integration',
  'tool',
  'compaction',
  'other',
] as const;

export type AIUsageSource = (typeof USAGE_SOURCES)[number];

const KNOWN = new Set<string>(USAGE_SOURCES);

/**
 * Coerce an arbitrary value to a known `AIUsageSource`. Any unknown string, typo, or
 * non-string (the field is optional and crosses untyped boundaries like jsonb) folds
 * to `'other'` so the breakdown never drops or mislabels spend.
 */
export function normalizeUsageSource(value: unknown): AIUsageSource {
  return typeof value === 'string' && KNOWN.has(value)
    ? (value as AIUsageSource)
    : 'other';
}

/** Human-facing labels for each source, used by the usage-breakdown UI. */
export const USAGE_SOURCE_LABELS: Record<AIUsageSource, string> = {
  chat: 'Chat',
  page_agent: 'Page agents',
  pulse: 'Pulse',
  memory: 'Memory',
  voice: 'Voice',
  workflow: 'Workflows',
  integration: 'Integrations',
  tool: 'Tools',
  compaction: 'Context compaction',
  other: 'Other',
};

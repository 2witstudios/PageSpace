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
  'image_generation',
  'compaction',
  'terminal',
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
  image_generation: 'Image generation',
  compaction: 'Context compaction',
  terminal: 'Terminal',
  other: 'Other',
};

/**
 * The `model` labels the sandbox storage meter writes for a persistence charge —
 * one per BILLED UNIT, not per substrate.
 *
 * They live here, beside the source vocabulary, because they are read by two
 * sides that must not drift: the meter that stamps them
 * (`services/sandbox/sandbox-storage-billing.ts`) and the usage breakdown that
 * splits an environment's storage out of the per-agent section
 * (`apps/web/src/lib/subscription/usage-breakdown.ts`). Both rows carry
 * `source: 'terminal'` and no `pageId`, so this label is the ONLY thing that
 * says which of the two a charge is — which is why it cannot be a string
 * literal spelled at each end.
 *
 * `session` keeps the string it has always been written under: renaming it
 * would split one meter's history across two labels in every existing usage
 * breakdown.
 */
export const SANDBOX_STORAGE_MODELS = {
  session: 'terminal-machine-storage',
  env: 'drive-env-storage',
} as const;

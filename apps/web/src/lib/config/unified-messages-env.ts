/**
 * The dual-write kill switch for the message-table unification
 * (epic "Agent-Session Single Source of Truth", Phase 4 — D6).
 *
 * During the expand window every page-chat write lands in BOTH
 * `chat_messages` (the legacy leg, still authoritative for every reader) and
 * `messages` (the unified leg, written ahead of the reader cutover). The
 * unified leg is additive by construction, but it is a NEW write on the hot
 * chat path, so it needs an off switch that does not require a deploy:
 *
 *   UNIFIED_MESSAGES_DUAL_WRITE unset / anything but 'off'  → dual-write ON
 *   UNIFIED_MESSAGES_DUAL_WRITE = 'off'                     → legacy leg only
 *
 * Default ON and disabled ONLY by the exact (case/whitespace-insensitive)
 * value 'off' — the same fail-safe-direction shape as CLICKHOUSE_ENABLED
 * (packages/lib/src/observability/clickhouse-env.ts), inverted because this
 * flag's safe steady state is enabled: a typo must not silently stop the
 * unified leg and let it drift behind the legacy one unnoticed.
 *
 * Read PER CALL, not memoized at module load, so flipping the variable takes
 * effect on the next process restart rather than needing a rebuild — and so
 * tests can stub it without module-cache surgery.
 *
 * Turning it off is NOT free: `messages` immediately falls behind, and the
 * `reconcile-message-unification` cron starts logging divergence at error
 * level (that is the point — the switch buys time, it does not hide the
 * cost). Re-running `scripts/backfill-unify-messages.ts` after re-enabling
 * closes the gap, since the backfill is idempotent and resumable.
 *
 * The variable is declared in the server env schema
 * (`packages/lib/src/config/env-validation.ts`) so it is a known, documented
 * variable rather than an undeclared `process.env` read scattered through the
 * repository. This module is the ONE place that reads it.
 */

export function isUnifiedMessageDualWriteEnabled(): boolean {
  return (process.env.UNIFIED_MESSAGES_DUAL_WRITE ?? '').trim().toLowerCase() !== 'off';
}

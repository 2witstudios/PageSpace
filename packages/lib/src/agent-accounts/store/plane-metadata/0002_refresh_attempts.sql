-- The refresh worker's per-account attempt ledger (L3·G3; ADR 0005 §5.1):
-- the `RefreshAttemptFact` `decideRefresh` reads as `lastAttempt` — consecutive
-- retryable failures, the time before which no refresh may be attempted, and
-- whether a rotation replay was seen. Timestamps are ms since epoch, as the
-- decision takes them. No material, ever. A successful refresh deletes the row.
CREATE TABLE IF NOT EXISTS agent_account_refresh_attempts (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  attempt_at bigint NOT NULL,
  consecutive_failures integer NOT NULL,
  retry_at bigint,
  rotation_replayed boolean NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);

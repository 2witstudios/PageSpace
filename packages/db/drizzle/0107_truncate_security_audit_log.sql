-- 0107: Truncate security_audit_log
--
-- security_audit_log accumulated ~2019 entries with a forked hash chain caused by
-- the same race condition as activity_logs (Apr 14-22 2026, now fixed). Unlike
-- activity_logs, event_hash and previous_hash are NOT NULL, so they cannot be
-- selectively nulled. The table held almost no real user data (early infra, minimal
-- traffic) and a prod infrastructure migration is imminent. Decision: truncate and
-- start clean. This migration versions that decision so future engineers know why
-- the table was wiped rather than finding an unexplained gap in the audit trail.

TRUNCATE security_audit_log;

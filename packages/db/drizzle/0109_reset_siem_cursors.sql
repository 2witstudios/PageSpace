-- 0109: Reset SIEM delivery cursors after chain and table resets
--
-- 0106 nulled logHash/previousLogHash/chainSeed on activity_logs rows.
-- 0107 truncated security_audit_log entirely.
-- Both leave siem_delivery_cursors.lastDeliveredId pointing at rows whose
-- anchor hash is now NULL or whose row no longer exists. runChainPreflight
-- fails closed when loadAnchorHash returns null for a non-sentinel cursor,
-- permanently halting SIEM delivery on every subsequent poll.
--
-- Nulling lastDeliveredId restores the "fresh cursor" path in
-- runChainPreflight (lastDeliveredId IS NULL → skip verification → deliver),
-- allowing delivery to resume cleanly from the next undelivered event.
-- Idempotent: no-op when the cursor rows don't exist yet.

UPDATE siem_delivery_cursors
SET "lastDeliveredId" = NULL,
    "lastDeliveredAt" = NULL
WHERE id IN ('activity_logs', 'security_audit_log');

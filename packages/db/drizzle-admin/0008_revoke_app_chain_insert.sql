-- Revoke admin_app's chain-table INSERT (#890 Phase 2 FIX — REVIEW finding:
-- zero-trust hole).
--
-- The Phase-1 grant matrix (0002) gave admin_app SELECT + INSERT on
-- security_audit_log for the pre-chainer write path. The leaf-5 runtime
-- cutover moved every app write to the security_audit_ingest queue (0004,
-- INSERT-only), making the chain-table INSERT excess privilege: a
-- compromised web credential could append chain-valid forged rows directly —
-- bypassing emission hashing and the co-stream witness — and the chainer
-- would link onto and anchor-witness them, invisible to the cron verifier.
--
-- Post-revoke, exactly one writer remains: admin_chainer (the processor's
-- single-writer worker). admin_app keeps SELECT — the web-side readers and
-- the periodic verifier read the chain and (0007) its anchors. Break-glass
-- is unaffected: it writes the MAIN database, not this one.
REVOKE INSERT ON security_audit_log FROM admin_app;
--> statement-breakpoint
-- The sequence USAGE existed only to serve the revoked INSERT's chain_seq
-- default; the chainer keeps its own grant from 0002.
REVOKE USAGE ON SEQUENCE security_audit_log_chain_seq_seq FROM admin_app;

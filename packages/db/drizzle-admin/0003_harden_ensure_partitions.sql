-- Per-month exception hardening of admin_ensure_partitions (#890 Phase 1 FIX,
-- REVIEW 2026-07-10 MINOR finding).
--
-- THE FAILURE THIS FIXES: rows for month M stranded in the DEFAULT partition
-- (e.g. after a >horizon cron outage) make CREATE TABLE ... FOR VALUES for
-- month M fail with "updated partition constraint for default partition would
-- be violated". In the 0002 version that single failure aborted the ENTIRE
-- call, rolling back every other month's creation — and because each NEW
-- month's rows then also land in DEFAULT, the poisoning self-perpetuates
-- until ops intervene.
--
-- HARDENING: each partition CREATE now runs in its own plpgsql exception
-- scope (a subtransaction), so a poisoned month M fails ALONE — every other
-- month is still created and committed. Failures are reported per partition
-- via RAISE WARNING (visible in the cron/postgres log) plus one summary
-- WARNING naming all failed partitions and the repair procedure. The function
-- still returns the created count; signature, SECURITY DEFINER, pinned
-- search_path, the 0..120 horizon guard, and the no-drop-path guarantee are
-- unchanged. CREATE OR REPLACE preserves the 0002 ACL (EXECUTE only to
-- admin_maintenance, PUBLIC revoked) — no grant statements here.
--
-- Alerting on DEFAULT-partition row count and the ops runbook are the Phase 6
-- half of this finding (task yz07brexk0hww6tuv20zhxbh on the Phase 6 page).
--
-- REPAIR (unchanged Postgres semantics, deliberately not automated): move the
-- stranded rows out of DEFAULT, rerun admin_ensure_partitions, re-insert.

CREATE OR REPLACE FUNCTION admin_ensure_partitions(months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  parent text;
  month_start date;
  part_name text;
  created integer := 0;
  failed text[] := '{}';
BEGIN
  IF months_ahead < 0 OR months_ahead > 120 THEN
    RAISE EXCEPTION 'admin_ensure_partitions: months_ahead must be between 0 and 120, got %', months_ahead;
  END IF;
  FOREACH parent IN ARRAY ARRAY['security_audit_log', 'siem_delivery_receipts'] LOOP
    part_name := parent || '_default';
    IF to_regclass(part_name) IS NULL THEN
      BEGIN
        EXECUTE format('CREATE TABLE %I PARTITION OF %I DEFAULT', part_name, parent);
        created := created + 1;
      EXCEPTION WHEN OTHERS THEN
        failed := failed || part_name;
        RAISE WARNING 'admin_ensure_partitions: failed to create %: %', part_name, SQLERRM;
      END;
    END IF;
    FOR i IN 0..months_ahead LOOP
      month_start := (date_trunc('month', now()) + make_interval(months => i))::date;
      part_name := parent || '_p' || to_char(month_start, 'YYYY_MM');
      IF to_regclass(part_name) IS NULL THEN
        BEGIN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            part_name, parent, month_start, (month_start + interval '1 month')::date
          );
          created := created + 1;
        EXCEPTION WHEN OTHERS THEN
          failed := failed || part_name;
          RAISE WARNING 'admin_ensure_partitions: failed to create %: %', part_name, SQLERRM;
        END;
      END IF;
    END LOOP;
  END LOOP;
  IF array_length(failed, 1) > 0 THEN
    RAISE WARNING 'admin_ensure_partitions: % partition(s) not created (%), % created. Likely DEFAULT-partition rows for those months — move them out of the DEFAULT partition, rerun, then re-insert.',
      array_length(failed, 1), array_to_string(failed, ', '), created;
  END IF;
  RETURN created;
END
$fn$;

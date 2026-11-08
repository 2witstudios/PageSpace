#!/usr/bin/env bash
# Sourced by scripts/deploy/run-fly-migration.sh. Never persist raw machine config or log text.
# FLY_APP selects the app the one-shot machine runs in (default: pagespace-web).
capture_migration_diagnostics() {
  local result=$?
  trap - EXIT
  set +e
  mkdir -p "$DIAGNOSTICS_DIR"
  if [ -f "$MACHINE_JSON" ]; then
    jq '
      def number_or_null: if type == "number" then . else null end;
      def boolean_or_null: if type == "boolean" then . else null end;
      def exit_fields:
        {exit_code: (.exit_code | number_or_null),
         guest_exit_code: (.guest_exit_code | number_or_null),
         signal: (.signal | number_or_null), guest_signal: (.guest_signal | number_or_null),
         oom_killed: (.oom_killed | boolean_or_null), requested_stop: (.requested_stop | boolean_or_null),
         exited_at: (.exited_at | if type == "string" and test("^[0-9TZ:.+-]+$") then . else null end)};
      {state: (.state | if IN("stopped", "started", "failed", "destroyed", "starting", "created") then . else "unknown" end),
       events: [.events[]? | select(.type == "exit") |
         {type: "exit", timestamp: (.timestamp | number_or_null),
          exit_event: ((.request.MonitorEvent.exit_event // .request.exit_event) | exit_fields)}]}
    ' "$MACHINE_JSON" > "$DIAGNOSTICS_DIR/events.json" || rm -f "$DIAGNOSTICS_DIR/events.json"
  fi
  if [ -n "$MACHINE_ID" ]; then
    # Logs can contain credentials unknown to this runner (inherited app secrets).
    # Keep only diagnostic vocabulary, never arbitrary message text or config.
    timeout 30 flyctl logs --instance "$MACHINE_ID" --app "${FLY_APP:-pagespace-web}" --no-tail 2>/dev/null |
      jq -Rr '[scan("(?i)\\b(migration|migrations|migrated|error|failed|failure|success|succeeded|complete|completed|timeout|panic|oom|killed)\\b")] | flatten | select(length > 0) | join(" ")' \
      > "$DIAGNOSTICS_DIR/logs.txt"
    flyctl machine destroy "$MACHINE_ID" --app "${FLY_APP:-pagespace-web}" --force 2>/dev/null || true
  fi
  exit "$result"
}

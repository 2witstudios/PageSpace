#!/usr/bin/env bash
# No migration is allowed until every application fleet is empty. Stopped VMs
# still count: Fly Proxy can auto-start them. Databases and volumes are untouched.
#
# MONEY-3 (#: cutover recovery): the SNAPSHOT and the DRAIN are separate steps, and the
# only copy of the restoration topology must be durably persisted BEFORE the first
# destructive scale operation. A one-shot run on an ephemeral runner that drains, then
# loses the snapshot to a runner failure (mid-migration, mid-deploy), leaves every fleet
# at zero with a fresh retry snapshotting EMPTY fleets — recovery inputs gone. CI splits
# this script around an artifact upload for exactly that reason.
#
# Usage:
#   fly-billing-cutover.sh <config-dir>                 snapshot, then drain (one-shot)
#   fly-billing-cutover.sh --snapshot-only <config-dir> snapshot only — no destructive call
#   fly-billing-cutover.sh --drain <config-dir>         drain only; REFUSES without a valid
#                                                       pre-drain snapshot for every app
# Resume: fly-billing-restore.sh loads this snapshot; it never takes a new one, so a fresh
# runner recovers the ORIGINAL topology instead of reconciling to empty.
set -euo pipefail
mode="both"
case "${1:-}" in
  --snapshot-only) mode="snapshot"; shift;;
  --drain) mode="drain"; shift;;
esac
config_dir="${1:?configuration snapshot directory required}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
apps=(pagespace-web pagespace-admin pagespace-realtime pagespace-processor pagespace-cron)

snapshot() {
  mkdir -p "$config_dir"
  for app in "${apps[@]}"; do
    flyctl config save --app "$app" --config "$config_dir/$app.toml" --yes
    flyctl machines list --app "$app" --json > "$config_dir/$app.machines.json"
    jq -ce -f "$script_dir/fly-machine-topology.jq" "$config_dir/$app.machines.json" > "$config_dir/$app.topology.json"
  done
  # Do not begin a cutover from an already broken scheduler deployment.
  jq -e 'map(.count) | add == 1' "$config_dir/pagespace-cron.topology.json" >/dev/null
}

drain() {
  # A drain without the ORIGINAL topology on disk cannot be recovered if this runner dies:
  # refuse rather than drain toward a snapshot a fresh retry could never take. The check
  # re-derives the topology from each app's machines list — the same filter restore uses —
  # so a truncated or hand-edited snapshot fails here, before anything is destroyed.
  for app in "${apps[@]}"; do
    if ! jq -ce -f "$script_dir/fly-machine-topology.jq" "$config_dir/$app.machines.json" >/dev/null 2>&1; then
      echo "ERROR: no valid pre-drain topology for $app under $config_dir — snapshot first; a drain with nothing to restore from is unrecoverable." >&2
      exit 1
    fi
  done
  for app in "${apps[@]}"; do
    counts=()
    while IFS= read -r group; do counts+=("$group=0"); done < <(jq -r '.[].group' "$config_dir/$app.topology.json" | sort -u)
    if [ "${#counts[@]}" -gt 0 ]; then flyctl scale count "${counts[@]}" --app "$app" --yes; fi
  done
  for app in "${apps[@]}"; do
    flyctl machines list --app "$app" --json | jq -e 'type == "array" and length == 0' >/dev/null
  done
}

case "$mode" in
  snapshot) snapshot;;
  drain) drain;;
  both) snapshot; drain;;
esac

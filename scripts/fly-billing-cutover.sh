#!/usr/bin/env bash
# No migration is allowed until every application fleet is empty. Stopped VMs
# still count: Fly Proxy can auto-start them. Databases and volumes are untouched.
#
# Two phases, so the topology can be made durable before anything is scaled to zero:
#   snapshot <dir>  saves and seals each fleet's configuration and topology. Non-destructive.
#   drain <dir>     verifies the sealed snapshot, then scales every recorded process group to 0.
# The workflow uploads the sealed snapshot between phases. The one-argument form runs both
# phases locally; production recovery requires the durable artifact from the workflow.
#
# Drain never snapshots. A snapshot is taken only from fleets that have machines, so a retry
# after a lost runner cannot overwrite the original topology with an empty one.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/fly-cutover-lib.sh"

case "$#" in
  1) mode=both; config_dir="$1" ;;
  2) mode="$1"; config_dir="$2" ;;
  *) cutover_fail "usage: fly-billing-cutover.sh [snapshot|drain] <configuration snapshot directory>" ;;
esac

case "$mode" in
  --snapshot-only) mode=snapshot ;;
  --drain) mode=drain ;;
  both|snapshot|drain) ;;
  *) cutover_fail "unknown cutover mode: $mode" ;;
esac

candidate="$(cutover_candidate)"

snapshot() {
  local stage app
  mkdir -p "$(dirname "$config_dir")"
  stage="$(mktemp -d "$config_dir.staging.XXXXXX")"
  for app in "${CUTOVER_APPS[@]}"; do
    # flyctl requires --config to exist before saving the remote configuration.
    # Seed only the app identity so no local build settings enter the snapshot.
    printf 'app = "%s"\n' "$app" > "$stage/$app.toml"
    flyctl config save --app "$app" --config "$stage/$app.toml" --yes
    flyctl machines list --app "$app" --json > "$stage/$app.machines.json"
    jq -ce -f "$script_dir/fly-machine-topology.jq" "$stage/$app.machines.json" > "$stage/$app.topology.json"
    if ! jq -e 'length > 0' "$stage/$app.topology.json" >/dev/null; then
      rm -rf "$stage"
      cutover_fail "$app has no machines; its topology cannot be restored from a snapshot taken now. Recover from the original sealed snapshot instead."
    fi
  done
  # Do not begin a cutover from an already broken scheduler deployment.
  if ! jq -e 'map(.count) | add == 1' "$stage/pagespace-cron.topology.json" >/dev/null; then
    rm -rf "$stage"
    cutover_fail "pagespace-cron must have exactly one machine before a cutover"
  fi
  cutover_seal "$stage" "$candidate"
  rm -rf "$config_dir"
  mv "$stage" "$config_dir"
}

drain() {
  local app group counts
  cutover_verify "$config_dir" "$candidate"
  for app in "${CUTOVER_APPS[@]}"; do
    counts=()
    while IFS= read -r group; do counts+=("$group=0"); done < <(jq -r '.[].group' "$config_dir/$app.topology.json" | sort -u)
    if [ "${#counts[@]}" -gt 0 ]; then flyctl scale count "${counts[@]}" --app "$app" --yes; fi
  done
  for app in "${CUTOVER_APPS[@]}"; do
    flyctl machines list --app "$app" --json | jq -e 'type == "array" and length == 0' >/dev/null \
      || cutover_fail "$app still has machines after drain; no migration may run"
  done
}

if [ "$mode" = both ] || [ "$mode" = snapshot ]; then
  if [ -f "$config_dir/COMPLETE" ]; then
    cutover_verify "$config_dir" "$candidate"
    echo "Reusing the sealed snapshot in $config_dir; no new snapshot is taken."
  else
    if [ -n "$(ls -A "$config_dir" 2>/dev/null || true)" ]; then
      cutover_fail "$config_dir holds an unsealed snapshot; refusing to overwrite it"
    fi
    snapshot
  fi
fi

if [ "$mode" = snapshot ]; then
  exit 0
fi

if [ "$mode" = both ]; then
  echo "WARNING: snapshot and drain ran in one job; the snapshot is durable only if it is uploaded before a later failure." >&2
fi
drain

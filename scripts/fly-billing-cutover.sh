#!/usr/bin/env bash
# No migration is allowed until every application fleet is empty. Stopped VMs
# still count: Fly Proxy can auto-start them. Databases and volumes are untouched.
set -euo pipefail
config_dir="${1:?configuration snapshot directory required}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$config_dir"
apps=(pagespace-web pagespace-admin pagespace-realtime pagespace-processor pagespace-cron)
for app in "${apps[@]}"; do
  flyctl config save --app "$app" --config "$config_dir/$app.toml" --yes
  flyctl machines list --app "$app" --json > "$config_dir/$app.machines.json"
  jq -ce -f "$script_dir/fly-machine-topology.jq" "$config_dir/$app.machines.json" > "$config_dir/$app.topology.json"
done
# Do not begin a cutover from an already broken scheduler deployment.
jq -e 'map(.count) | add == 1' "$config_dir/pagespace-cron.topology.json" >/dev/null
for app in "${apps[@]}"; do
  counts=()
  while IFS= read -r group; do counts+=("$group=0"); done < <(jq -r '.[].group' "$config_dir/$app.topology.json" | sort -u)
  if [ "${#counts[@]}" -gt 0 ]; then flyctl scale count "${counts[@]}" --app "$app" --yes; fi
done
for app in "${apps[@]}"; do
  flyctl machines list --app "$app" --json | jq -e 'type == "array" and length == 0' >/dev/null
done

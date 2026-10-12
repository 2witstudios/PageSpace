#!/usr/bin/env bash
# No migration is allowed until every application fleet is empty. Stopped VMs
# still count: Fly Proxy can auto-start them. Databases and volumes are untouched.
set -euo pipefail
config_dir="${1:?configuration snapshot directory required}"
mkdir -p "$config_dir"
apps=(pagespace-web pagespace-admin pagespace-realtime pagespace-processor pagespace-cron)
for app in "${apps[@]}"; do
  flyctl config save --app "$app" --config "$config_dir/$app.toml" --yes
done
for app in "${apps[@]}"; do
  flyctl scale count 0 --app "$app" --yes
done
for app in "${apps[@]}"; do
  flyctl machines list --app "$app" --json | jq -e 'type == "array" and length == 0' >/dev/null
done

#!/usr/bin/env bash
# Restore capacity/placement after deploy has seeded final-image Machines.
set -euo pipefail
config_dir="${1:?snapshot directory required}"
app="${2:?app required}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
desired="$(jq -ce -f "$script_dir/fly-machine-topology.jq" "$config_dir/$app.machines.json")"
# Grow the desired regions first so a seed is available for each process group.
while IFS=$'\t' read -r group region count; do
  flyctl scale count "$group=$count" --region "$region" --app "$app" --yes
done < <(echo "$desired" | jq -r '.[] | [.group, .region, .count] | @tsv')
current="$(flyctl machines list --app "$app" --json | jq -ce -f "$script_dir/fly-machine-topology.jq")"
while IFS=$'\t' read -r group region; do
  flyctl scale count "$group=0" --region "$region" --app "$app" --yes
done < <(echo "$current" | jq -r --argjson desired "$desired" '.[] | . as $pair | select(any($desired[]; .group == $pair.group and .region == $pair.region) | not) | [.group, .region] | @tsv')
actual="$(flyctl machines list --app "$app" --json | jq -ce -f "$script_dir/fly-machine-topology.jq")"
if [ "$actual" != "$desired" ]; then
  echo "ERROR: $app topology does not match the pre-cutover inventory" >&2
  exit 1
fi

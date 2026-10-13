#!/usr/bin/env bash
# Restore capacity/placement after deploy has seeded final-image Machines.
#
# MONEY-3: this script RESUMES from the pre-drain snapshot — it never takes a new one, so
# a fresh runner recovers the ORIGINAL topology (a fresh `machines list` of drained fleets
# would read as empty and reconcile everything to zero). A missing or unreadable snapshot
# is a hard error naming the recovery contract, not a silent skip.
set -euo pipefail
config_dir="${1:?snapshot directory required}"
app="${2:?app required}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$config_dir/$app.machines.json" ] || [ ! -f "$config_dir/$app.toml" ]; then
  echo "ERROR: no pre-drain snapshot for $app under $config_dir — restore requires the ORIGINAL topology captured by fly-billing-cutover.sh before it drained; a fresh snapshot of drained fleets would restore them as empty." >&2
  exit 1
fi
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

# Sourced by fly-billing-cutover.sh and fly-billing-restore.sh. The sealed snapshot is the
# only record of the pre-cutover fleet topology: a Fly fleet scaled to zero keeps no
# record of its regions or process-group counts. It is sealed (checksummed and bound to one
# candidate commit) before the first destructive call, and every later step verifies the seal
# before trusting a single number in it.

CUTOVER_APPS=(pagespace-web pagespace-admin pagespace-realtime pagespace-processor pagespace-cron)

cutover_fail() {
  echo "ERROR: $*" >&2
  exit 1
}

cutover_candidate() {
  local candidate="${CUTOVER_CANDIDATE_SHA:-${GITHUB_SHA:-}}"
  [ -n "$candidate" ] || cutover_fail "set CUTOVER_CANDIDATE_SHA to the candidate commit this snapshot belongs to"
  printf '%s\n' "$candidate"
}

# Checksums cover the snapshot data files and the candidate; COMPLETE is written last, so an
# interrupted snapshot never looks sealed.
cutover_seal() {
  local dir="$1" candidate="$2"
  printf '%s\n' "$candidate" > "$dir/CANDIDATE"
  (
    cd "$dir"
    local files=(CANDIDATE) app
    for app in "${CUTOVER_APPS[@]}"; do
      files+=("$app.toml" "$app.machines.json" "$app.topology.json")
    done
    shasum -a 256 "${files[@]}" > SHA256SUMS
  )
  printf '%s\n' "$candidate" > "$dir/COMPLETE"
}

cutover_verify() {
  local dir="$1" candidate="$2"
  [ -f "$dir/COMPLETE" ] || cutover_fail "$dir holds no sealed snapshot; refusing to act on an unverified topology"
  (cd "$dir" && shasum -a 256 -c SHA256SUMS >/dev/null) \
    || cutover_fail "snapshot in $dir fails its checksums; it was altered, truncated or lost a file"
  local app
  for app in "${CUTOVER_APPS[@]}"; do
    [ -f "$dir/$app.toml" ] && [ -f "$dir/$app.machines.json" ] && [ -f "$dir/$app.topology.json" ] \
      || cutover_fail "snapshot is missing original configuration or topology for $app"
  done
  local sealed
  sealed="$(cat "$dir/CANDIDATE")"
  [ "$(cat "$dir/COMPLETE")" = "$sealed" ] || cutover_fail "snapshot completion marker differs from its candidate"
  [ "$sealed" = "$candidate" ] || cutover_fail "snapshot in $dir was sealed for $sealed, not $candidate"
}

#!/usr/bin/env bash
# Push the migrate image into a Fly app's registry namespace, run it as a one-off
# machine, and wait for it to finish.
#
# The migration image exits before flyctl considers the machine "started", so
# `flyctl machine run` reports "failed to reach desired start state" even on a
# successful migration. That's expected — this script verifies success by
# polling the Machines REST API for the machine's exit evidence instead of
# trusting flyctl's own exit code. "stopped" alone does not prove success: with
# --restart no the machine stops on ANY exit, so success additionally requires a
# clean exit record (scripts/fly-migration-succeeded.jq).
#
# On EXIT (success or failure) scripts/fly-migration-diagnostics.sh captures
# sanitized exit evidence and a vocabulary-only log summary into $DIAGNOSTICS_DIR,
# then destroys the one-shot machine.
#
# Usage:
#   run-fly-migration.sh <fly-app> <ghcr-image> <tag> [-- extra flyctl machine run args...]
#
# Example:
#   run-fly-migration.sh pagespace-web-staging \
#     ghcr.io/2witstudios/pagespace-migrate sha-<full-sha>
#
# Required env: FLY_API_TOKEN
# Optional env: DIAGNOSTICS_DIR (default: $RUNNER_TEMP/migration-diagnostics/<fly-app>)
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: run-fly-migration.sh <fly-app> <ghcr-image> <tag> [-- extra flyctl machine run args...]" >&2
  exit 2
fi

FLY_APP="$1"
GHCR_IMAGE="$2"
TAG="$3"
shift 3
if [ "${1:-}" = "--" ]; then
  shift
fi
EXTRA_ARGS=("$@")

: "${FLY_API_TOKEN:?FLY_API_TOKEN must be set}"

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_JQ="$SCRIPTS_DIR/fly-migration-succeeded.jq"

FULL_GHCR_IMAGE="${GHCR_IMAGE}:${TAG}"
FLY_IMAGE="registry.fly.io/${FLY_APP}:migrate-${TAG}"
MACHINE_NAME="migrations-$(date +%s)"
WORK_DIR="$(mktemp -d)"
OUTPUT_FILE="$WORK_DIR/machine_output.txt"

# Read by capture_migration_diagnostics (sourced below) when the trap fires.
export FLY_APP
DIAGNOSTICS_DIR="${DIAGNOSTICS_DIR:-${RUNNER_TEMP:-$WORK_DIR}/migration-diagnostics/$FLY_APP}"
MACHINE_JSON="$WORK_DIR/fly_machine.json"
MACHINE_ID=""
# shellcheck source=../fly-migration-diagnostics.sh
source "$SCRIPTS_DIR/fly-migration-diagnostics.sh"
trap capture_migration_diagnostics EXIT

echo "--- Running migrations on $FLY_APP ($FULL_GHCR_IMAGE) ---"
docker pull "$FULL_GHCR_IMAGE"
docker tag "$FULL_GHCR_IMAGE" "$FLY_IMAGE"
docker push "$FLY_IMAGE"

flyctl machine run "$FLY_IMAGE" \
  --app "$FLY_APP" \
  --name "$MACHINE_NAME" \
  --region iad \
  --restart no \
  "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" \
  2>&1 | tee "$OUTPUT_FILE" || true

MACHINE_ID=$(grep -o 'Machine ID: [0-9a-f]*' "$OUTPUT_FILE" | head -1 | sed 's/Machine ID: //' || true)
if [ -z "$MACHINE_ID" ]; then
  echo "ERROR: could not parse machine ID from flyctl output" >&2
  cat "$OUTPUT_FILE" >&2
  exit 1
fi
echo "Migration machine: $MACHINE_ID"

if grep -q "Error:" "$OUTPUT_FILE" && ! grep -q "desired start state" "$OUTPUT_FILE"; then
  echo "ERROR: unexpected flyctl error:" >&2
  grep "Error:" "$OUTPUT_FILE" >&2
  exit 1
fi

# Poll for terminal state, then verify exit evidence: stopped alone does not prove success.
# flyctl machine wait --state stopped hangs the full timeout when migrations fail because
# the machine is already in "failed" state, not "stopped", so poll the REST API instead.
TIMEOUT=900
ELAPSED=0
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  HTTP_CODE=$(curl --connect-timeout 10 --max-time 30 -s -o "$MACHINE_JSON" -w "%{http_code}" \
    -H "Authorization: Bearer $FLY_API_TOKEN" \
    "https://api.machines.dev/v1/apps/$FLY_APP/machines/$MACHINE_ID" || true)
  if [ "$HTTP_CODE" = "200" ]; then
    STATE=$(jq -r '.state // "unknown"' "$MACHINE_JSON" 2>/dev/null || echo "unknown")
  elif [ "$HTTP_CODE" = "404" ]; then
    echo "ERROR: migration machine $MACHINE_ID not found (unexpectedly destroyed)" >&2
    exit 1
  else
    STATE="unknown"
  fi
  echo "  [${ELAPSED}s] state: $STATE"
  if [ "$HTTP_CODE" = "200" ] && jq -e --arg mode failed -f "$EVIDENCE_JQ" "$MACHINE_JSON" >/dev/null; then
    echo "ERROR: migration exit evidence indicates failure"
    exit 1
  fi
  if [ "$STATE" = "stopped" ]; then
    if jq -e -f "$EVIDENCE_JQ" "$MACHINE_JSON" >/dev/null; then
      break
    fi
    echo "Exit evidence pending; waiting within ${TIMEOUT}s deadline"
  elif [ "$STATE" = "failed" ] || [ "$STATE" = "destroyed" ]; then
    echo "ERROR: migration machine reached $STATE state (migrations failed)"
    exit 1
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
  echo "ERROR: timed out after ${TIMEOUT}s waiting for migration machine"
  exit 1
fi

echo "Migrations complete on $FLY_APP"

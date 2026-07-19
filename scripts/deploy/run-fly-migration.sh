#!/usr/bin/env bash
# Push the migrate image into a Fly app's registry namespace, run it as a one-off
# machine, and wait for it to finish.
#
# The migration image exits before flyctl considers the machine "started", so
# `flyctl machine run` reports "failed to reach desired start state" even on a
# successful migration. That's expected — this script verifies success by
# polling the Machines REST API for the machine's terminal state instead of
# trusting flyctl's own exit code.
#
# Usage:
#   run-fly-migration.sh <fly-app> <ghcr-image> <tag> [-- extra flyctl machine run args...]
#
# Example:
#   run-fly-migration.sh pagespace-web-staging \
#     ghcr.io/2witstudios/pagespace-migrate sha-abc1234
#
# Required env: FLY_API_TOKEN
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

FULL_GHCR_IMAGE="${GHCR_IMAGE}:${TAG}"
FLY_IMAGE="registry.fly.io/${FLY_APP}:migrate-${TAG}"
MACHINE_NAME="migrations-$(date +%s)"
OUTPUT_FILE="$(mktemp)"
STATE_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE" "$STATE_FILE"' EXIT

echo "--- Running migrations on $FLY_APP ($FULL_GHCR_IMAGE) ---"
docker pull "$FULL_GHCR_IMAGE"
docker tag "$FULL_GHCR_IMAGE" "$FLY_IMAGE"
docker push "$FLY_IMAGE"

flyctl machine run "$FLY_IMAGE" \
  --app "$FLY_APP" \
  --name "$MACHINE_NAME" \
  --region iad \
  --restart no \
  "${EXTRA_ARGS[@]}" \
  2>&1 | tee "$OUTPUT_FILE" || true

MACHINE_ID=$(grep -oP 'Machine ID: \K[0-9a-f]+' "$OUTPUT_FILE" | head -1)
if [ -z "$MACHINE_ID" ]; then
  echo "ERROR: could not parse machine ID from flyctl output" >&2
  cat "$OUTPUT_FILE" >&2
  exit 1
fi
echo "Migration machine: $MACHINE_ID"

if grep -q "Error:" "$OUTPUT_FILE" && ! grep -q "desired start state" "$OUTPUT_FILE"; then
  echo "ERROR: unexpected flyctl error:" >&2
  grep "Error:" "$OUTPUT_FILE" >&2
  flyctl machine destroy "$MACHINE_ID" --app "$FLY_APP" --force 2>/dev/null || true
  exit 1
fi

TIMEOUT=900
ELAPSED=0
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  HTTP_CODE=$(curl -s -o "$STATE_FILE" -w "%{http_code}" \
    -H "Authorization: Bearer $FLY_API_TOKEN" \
    "https://api.machines.dev/v1/apps/$FLY_APP/machines/$MACHINE_ID") || HTTP_CODE="000"
  if [ "$HTTP_CODE" = "200" ]; then
    STATE=$(jq -r '.state // "unknown"' "$STATE_FILE" 2>/dev/null || echo "unknown")
  elif [ "$HTTP_CODE" = "404" ]; then
    echo "ERROR: migration machine $MACHINE_ID not found (unexpectedly destroyed)" >&2
    exit 1
  else
    STATE="unknown"
  fi
  echo "  [${ELAPSED}s] state: $STATE"
  if [ "$STATE" = "stopped" ]; then
    break
  elif [ "$STATE" = "failed" ] || [ "$STATE" = "destroyed" ]; then
    echo "ERROR: migration machine reached $STATE state (migrations failed)" >&2
    flyctl machine logs "$MACHINE_ID" --app "$FLY_APP" 2>/dev/null || true
    flyctl machine destroy "$MACHINE_ID" --app "$FLY_APP" --force 2>/dev/null || true
    exit 1
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
  echo "ERROR: timed out after ${TIMEOUT}s waiting for migration machine" >&2
  flyctl machine destroy "$MACHINE_ID" --app "$FLY_APP" --force 2>/dev/null || true
  exit 1
fi

flyctl machine destroy "$MACHINE_ID" --app "$FLY_APP" --force
echo "Migrations complete on $FLY_APP"

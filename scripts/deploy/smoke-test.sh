#!/usr/bin/env bash
# Post-deploy smoke test: poll /api/health until it reports a genuinely healthy,
# DB-connected instance (not just "the process answers HTTP").
#
# Usage:
#   smoke-test.sh <base-url> [retries] [delay-seconds]
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: smoke-test.sh <base-url> [retries] [delay-seconds]" >&2
  exit 2
fi

BASE_URL="${1%/}"
RETRIES="${2:-6}"
DELAY="${3:-10}"
HEALTH_URL="$BASE_URL/api/health"
RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT

echo "--- Smoke testing $HEALTH_URL ---"

for i in $(seq 1 "$RETRIES"); do
  # curl already prints "000" via -w on total connection failure; falling back to a
  # literal "000" (not appending one) avoids HTTP_CODE becoming "000000" when both fire.
  HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" --max-time 10 "$HEALTH_URL") || HTTP_CODE="000"

  if [ "$HTTP_CODE" = "200" ]; then
    STATUS=$(jq -r '.status // ""' "$RESPONSE_FILE" 2>/dev/null || echo "")
    DATABASE=$(jq -r '.checks.database // ""' "$RESPONSE_FILE" 2>/dev/null || echo "")

    if [ "$STATUS" = "healthy" ] && [ "$DATABASE" = "connected" ]; then
      echo "Smoke test PASSED: $HEALTH_URL -> 200, status=healthy, database=connected"
      exit 0
    fi

    echo "  [$i/$RETRIES] HTTP 200 but status=$STATUS database=$DATABASE — retrying in ${DELAY}s"
  else
    echo "  [$i/$RETRIES] HTTP $HTTP_CODE — retrying in ${DELAY}s"
  fi

  sleep "$DELAY"
done

echo "Smoke test FAILED after $RETRIES attempts against $HEALTH_URL" >&2
echo "Last response:" >&2
cat "$RESPONSE_FILE" >&2 2>/dev/null || true
exit 1

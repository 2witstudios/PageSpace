#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BASE_URL="${BASE_URL:-http://localhost:3000}"
INFLUXDB_HOST="${INFLUXDB_HOST:-localhost}"
INFLUXDB_URL="http://${INFLUXDB_HOST}:8086/k6"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3001}"
K6_OUT_ARGS=(--out "influxdb=${INFLUXDB_URL}")

echo "==> Starting monitoring stack..."
docker compose -f "$REPO_ROOT/docker-compose.monitoring.yml" up -d

echo "==> Waiting for InfluxDB to be ready..."
MAX_WAIT=60
WAITED=0
until curl -sf "http://${INFLUXDB_HOST}:8086/health" > /dev/null 2>&1; do
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo "ERROR: InfluxDB did not become healthy within ${MAX_WAIT}s" >&2
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  echo "  ...waiting (${WAITED}s)"
done
echo "  InfluxDB is ready."

SEED_SCRIPT="$REPO_ROOT/tests/load/scripts/seed-load-user.ts"
if [ -f "$SEED_SCRIPT" ]; then
  echo "==> Seeding load test user..."
  pnpm exec tsx "$SEED_SCRIPT"
else
  echo "WARNING: Seed script not found at $SEED_SCRIPT — skipping user seed."
fi

echo "==> Running k6 scenarios..."
SCENARIOS_DIR="$REPO_ROOT/tests/load/scenarios"
AUTH_FILE="$REPO_ROOT/.k6-auth.json"

if [ ! -d "$SCENARIOS_DIR" ]; then
  echo "WARNING: No scenarios directory found at $SCENARIOS_DIR — skipping k6 runs."
else
  for scenario in "$SCENARIOS_DIR"/*.js; do
    [ -f "$scenario" ] || continue
    echo "  Running: $(basename "$scenario")"
    docker run --rm \
      --network host \
      -v "$REPO_ROOT/tests/load:/tests/load" \
      -v "$AUTH_FILE:/k6-auth.json:ro" \
      grafana/k6:0.55.0 run \
        "${K6_OUT_ARGS[@]}" \
        -e BASE_URL="$BASE_URL" \
        -e AUTH_FILE="/k6-auth.json" \
        "/tests/load/scenarios/$(basename "$scenario")"
  done
fi

CLEANUP_SCRIPT="$REPO_ROOT/tests/load/scripts/cleanup-load-user.ts"
if [ -f "$CLEANUP_SCRIPT" ]; then
  echo "==> Cleaning up load test user..."
  pnpm exec tsx "$CLEANUP_SCRIPT" || true
fi

echo ""
echo "==> Load test complete."
echo "    Grafana dashboard: ${GRAFANA_URL}"
echo "    InfluxDB UI:       http://${INFLUXDB_HOST}:8086"
echo "    Prometheus:        http://localhost:9090"

#!/usr/bin/env bash
# Pull a GHCR image, retag it into the Fly registry, and deploy it to a Fly app.
#
# Billing cutover (MONEY-3): when CUTOVER_DIR is set and holds a restoration
# snapshot for this app (scripts/fly-billing-cutover.sh), deploy with the
# snapshotted <app>.toml config and afterwards restore the drained fleet from
# <app>.machines.json via scripts/fly-billing-restore.sh. Without a snapshot the
# deploy is a plain image swap.
#
# Usage:
#   deploy-fly-service.sh <fly-app> <ghcr-image> <tag> [wait-timeout-seconds]
#
# Example:
#   deploy-fly-service.sh pagespace-web-staging \
#     ghcr.io/2witstudios/pagespace-web sha-<full-sha> 180
#
# Optional env: CUTOVER_DIR (billing cutover snapshot directory)
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: deploy-fly-service.sh <fly-app> <ghcr-image> <tag> [wait-timeout-seconds]" >&2
  exit 2
fi

FLY_APP="$1"
GHCR_IMAGE="$2"
TAG="$3"
WAIT_TIMEOUT="${4:-300}"

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FULL_GHCR_IMAGE="${GHCR_IMAGE}:${TAG}"
FLY_IMAGE="registry.fly.io/${FLY_APP}:${TAG}"

config_args=()
if [ -n "${CUTOVER_DIR:-}" ] && [ -f "$CUTOVER_DIR/$FLY_APP.toml" ]; then
  config_args=(--config "$CUTOVER_DIR/$FLY_APP.toml")
fi

echo "--- Deploying $FLY_APP from $FULL_GHCR_IMAGE ---"
docker pull "$FULL_GHCR_IMAGE"
docker tag "$FULL_GHCR_IMAGE" "$FLY_IMAGE"
docker push "$FLY_IMAGE"
flyctl deploy "${config_args[@]+"${config_args[@]}"}" --app "$FLY_APP" --image "$FLY_IMAGE" --wait-timeout "$WAIT_TIMEOUT"

if [ -n "${CUTOVER_DIR:-}" ] && [ -f "$CUTOVER_DIR/$FLY_APP.machines.json" ]; then
  bash "$SCRIPTS_DIR/fly-billing-restore.sh" "$CUTOVER_DIR" "$FLY_APP"
fi

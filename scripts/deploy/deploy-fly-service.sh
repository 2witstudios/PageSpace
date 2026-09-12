#!/usr/bin/env bash
# Pull a GHCR image, retag it into the Fly registry, and deploy it to a Fly app.
#
# Usage:
#   deploy-fly-service.sh <fly-app> <ghcr-image> <tag> [wait-timeout-seconds]
#
# Example:
#   deploy-fly-service.sh pagespace-web-staging \
#     ghcr.io/2witstudios/pagespace-web sha-abc1234 180
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: deploy-fly-service.sh <fly-app> <ghcr-image> <tag> [wait-timeout-seconds]" >&2
  exit 2
fi

FLY_APP="$1"
GHCR_IMAGE="$2"
TAG="$3"
WAIT_TIMEOUT="${4:-300}"

FULL_GHCR_IMAGE="${GHCR_IMAGE}:${TAG}"
FLY_IMAGE="registry.fly.io/${FLY_APP}:${TAG}"

echo "--- Deploying $FLY_APP from $FULL_GHCR_IMAGE ---"
docker pull "$FULL_GHCR_IMAGE"
docker tag "$FULL_GHCR_IMAGE" "$FLY_IMAGE"
docker push "$FLY_IMAGE"
flyctl deploy --app "$FLY_APP" --image "$FLY_IMAGE" --wait-timeout "$WAIT_TIMEOUT"

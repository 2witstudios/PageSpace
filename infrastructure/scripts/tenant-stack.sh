#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.tenant.yml"

usage() {
  cat >&2 <<EOF
Usage: tenant-stack.sh <command> <slug> [options]

Commands:
  up        Start the tenant stack
  down      Stop and remove the tenant stack
  status    Show container status
  health    Check web service health endpoint
  upgrade   Pull latest images and recreate services

Options:
  --env-file <path>   Path to .env file (default: /data/tenants/<slug>/.env)
  --image-tag <tag>   Override IMAGE_TAG for upgrade
EOF
  exit 1
}

validate_slug() {
  local slug="$1"
  if ! [[ "$slug" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
    echo "Error: Invalid slug '$slug'. Must be lowercase alphanumeric with optional hyphens." >&2
    exit 1
  fi
}

if [[ $# -lt 1 ]]; then
  usage
fi

COMMAND="$1"
shift

case "$COMMAND" in
  up|down|status|health|upgrade) ;;
  *)
    echo "Error: Unknown command '$COMMAND'" >&2
    usage
    ;;
esac

if [[ $# -lt 1 ]]; then
  echo "Error: Missing slug argument" >&2
  usage
fi

SLUG="$1"
shift
validate_slug "$SLUG"

PROJECT="ps-${SLUG}"
ENV_FILE="/data/tenants/${SLUG}/.env"
IMAGE_TAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --image-tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    *)
      echo "Error: Unknown option $1" >&2
      exit 1
      ;;
  esac
done

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# Support DRY_RUN for testing
if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "DRY_RUN: command=$COMMAND slug=$SLUG project=$PROJECT env_file=$ENV_FILE"
  exit 0
fi

case "$COMMAND" in
  up)
    echo "Starting tenant stack: ${PROJECT}"
    compose up -d
    echo "Tenant stack ${PROJECT} started"
    ;;
  down)
    echo "Stopping tenant stack: ${PROJECT}"
    compose down
    echo "Tenant stack ${PROJECT} stopped"
    ;;
  status)
    compose ps
    ;;
  health)
    WEB_URL="https://${SLUG}.pagespace.ai"
    echo "Checking health for ${SLUG}..."
    if curl -sf "${WEB_URL}/api/health" > /dev/null 2>&1; then
      echo "Healthy: ${WEB_URL}"
    else
      echo "Unhealthy or unreachable: ${WEB_URL}" >&2
      exit 1
    fi
    ;;
  upgrade)
    echo "Upgrading tenant stack: ${PROJECT}"
    if [[ -n "$IMAGE_TAG" ]]; then
      export IMAGE_TAG
    fi
    compose pull
    for svc in processor web realtime cron; do
      echo "Recreating ${svc}..."
      compose up -d --no-deps "$svc"
    done
    echo "Tenant stack ${PROJECT} upgraded"
    ;;
esac

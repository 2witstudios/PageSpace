#!/usr/bin/env bash
set -euo pipefail

SLUG=""
IMAGE_TAG="latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image-tag)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --image-tag requires a value" >&2
        exit 1
      fi
      IMAGE_TAG="$2"
      shift 2
      ;;
    -*)
      echo "Error: Unknown option $1" >&2
      exit 1
      ;;
    *)
      if [[ -z "$SLUG" ]]; then
        SLUG="$1"
      else
        echo "Error: Unexpected argument $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$SLUG" ]]; then
  echo "Usage: generate-tenant-env.sh <slug> [--image-tag <tag>]" >&2
  exit 1
fi

if ! [[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "Error: Invalid slug '$SLUG'. Must be lowercase alphanumeric with optional hyphens, not starting/ending with hyphen." >&2
  exit 1
fi

hex_secret() { openssl rand -hex "$1"; }
alnum_secret() { openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c "$1"; }

TENANT_URL="https://${SLUG}.pagespace.ai"

cat <<EOF
# PageSpace Tenant Environment - ${SLUG}
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- Tenant Identity ---
TENANT_SLUG=${SLUG}

# --- Image Config ---
IMAGE_TAG=${IMAGE_TAG}

# --- Deployment Mode ---
DEPLOYMENT_MODE=tenant

# --- Database ---
POSTGRES_DB=pagespace
POSTGRES_USER=pagespace
POSTGRES_PASSWORD=$(alnum_secret 32)

# --- Security Secrets ---
ENCRYPTION_KEY=$(hex_secret 32)
CSRF_SECRET=$(hex_secret 32)
JWT_SECRET=$(hex_secret 64)
JWT_ISSUER=pagespace
JWT_AUDIENCE=pagespace-users
CRON_SECRET=$(hex_secret 32)
REALTIME_BROADCAST_SECRET=$(hex_secret 32)
REDIS_PASSWORD=$(alnum_secret 32)

# --- Application URLs ---
WEB_APP_URL=${TENANT_URL}
CORS_ORIGIN=${TENANT_URL}
NEXT_PUBLIC_APP_URL=${TENANT_URL}

# --- Storage Config ---
STORAGE_DEFAULT_QUOTA_MB=500
STORAGE_MAX_FILE_SIZE_MB=20
STORAGE_MAX_CONCURRENT_UPLOADS=5
STORAGE_MIN_FREE_MEMORY_MB=500
STORAGE_ENABLE_QUOTAS=true
NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB=20

# --- Processor Config ---
ENABLE_OCR=false
ENABLE_EXTERNAL_OCR=false
PROCESSOR_AUTH_REQUIRED=true
PROCESSOR_UPLOAD_RATE_LIMIT=100
PROCESSOR_UPLOAD_RATE_WINDOW=3600

# --- AI Providers (optional) ---
GOOGLE_AI_DEFAULT_API_KEY=
EOF

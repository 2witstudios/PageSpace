#!/bin/sh
# Cron container entrypoint
# Sets up HMAC-signed cron request helper and starts crond.
#
# Alpine crond does not pass environment variables to cron jobs,
# so we bake the CRON_SECRET into a signing helper at startup.

if [ -z "$CRON_SECRET" ]; then
  echo "[cron] WARNING: CRON_SECRET is not set. Cron requests will rely on network-only auth."
fi

# Create the HMAC-signed curl helper used by crontab entries
cat > /usr/local/bin/cron-curl <<'SCRIPT'
#!/bin/sh
# cron-curl: Send HMAC-signed requests to cron endpoints
# Usage: cron-curl <METHOD> <URL>
#
# Generates X-Cron-Timestamp, X-Cron-Nonce, and X-Cron-Signature headers
# using HMAC-SHA256(CRON_SECRET, timestamp:nonce:method:path)

METHOD="$1"
URL="$2"
CRON_SECRET_VAL="__CRON_SECRET__"

if [ -z "$METHOD" ] || [ -z "$URL" ]; then
  echo "Usage: cron-curl <METHOD> <URL>" >&2
  exit 1
fi

# Extract path from URL (everything after host:port)
PATH_PART=$(echo "$URL" | sed 's|^https\?://[^/]*||')

TIMESTAMP=$(date +%s)
NONCE=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
MESSAGE="${TIMESTAMP}:${NONCE}:${METHOD}:${PATH_PART}"

if [ -n "$CRON_SECRET_VAL" ]; then
  SIGNATURE=$(printf '%s' "$MESSAGE" | openssl dgst -sha256 -hmac "$CRON_SECRET_VAL" -hex 2>/dev/null | sed 's/^.* //')
  curl -s -X "$METHOD" \
    -H "X-Cron-Timestamp: ${TIMESTAMP}" \
    -H "X-Cron-Nonce: ${NONCE}" \
    -H "X-Cron-Signature: ${SIGNATURE}" \
    "$URL"
else
  # No secret configured — send without HMAC headers (dev/fallback)
  curl -s -X "$METHOD" "$URL"
fi
SCRIPT

# Inject the actual secret value into the helper script using awk for literal-safe replacement
# (sed can break if CRON_SECRET contains |, &, \, or other metacharacters)
awk -v secret="$CRON_SECRET" '{ gsub(/__CRON_SECRET__/, secret); print }' /usr/local/bin/cron-curl > /usr/local/bin/cron-curl.tmp \
  && mv /usr/local/bin/cron-curl.tmp /usr/local/bin/cron-curl
chmod 700 /usr/local/bin/cron-curl

exec crond -f -d 8

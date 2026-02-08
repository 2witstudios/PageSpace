#!/bin/sh
# Substitute CRON_SECRET into crontab template
# Alpine crond does not pass environment variables to cron jobs,
# so we replace the placeholder at container startup.

if [ -z "$CRON_SECRET" ]; then
  echo "[cron] WARNING: CRON_SECRET is not set. Cron requests will rely on network-only auth."
fi

# Replace ${CRON_SECRET} placeholder in the crontab with the actual value
sed -i "s|\${CRON_SECRET}|${CRON_SECRET}|g" /etc/crontabs/root

exec crond -f -d 8

# Lightweight cron service for PageSpace
# Runs scheduled jobs inside Docker network, hitting internal URLs

FROM alpine:3.21

# curl/openssl for HMAC-signed requests; flock (util-linux) so entries that
# must not overlap themselves (e.g. reconcile-machine-storage) can serialize
RUN apk add --no-cache curl openssl flock

# Create log directory
RUN mkdir -p /var/log/cron

# Copy crontab and entrypoint
COPY crontab /etc/crontabs/root
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Entrypoint substitutes CRON_SECRET into crontab, then starts crond
ENTRYPOINT ["/entrypoint.sh"]

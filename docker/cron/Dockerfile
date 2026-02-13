# Lightweight cron service for PageSpace
# Runs scheduled jobs inside Docker network, hitting internal URLs

FROM alpine:3.21

# Install curl for making HTTP requests
RUN apk add --no-cache curl

# Create log directory
RUN mkdir -p /var/log/cron

# Copy crontab and entrypoint
COPY crontab /etc/crontabs/root
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Entrypoint substitutes CRON_SECRET into crontab, then starts crond
ENTRYPOINT ["/entrypoint.sh"]

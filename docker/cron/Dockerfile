# Lightweight cron service for PageSpace
# Runs scheduled jobs inside Docker network, hitting internal URLs

FROM alpine:3.21

# Install curl for making HTTP requests
RUN apk add --no-cache curl

# Create log directory
RUN mkdir -p /var/log/cron

# Copy crontab
COPY crontab /etc/crontabs/root

# Run crond in foreground with log level 8 (default)
CMD ["crond", "-f", "-d", "8"]

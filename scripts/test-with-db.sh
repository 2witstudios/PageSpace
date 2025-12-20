#!/bin/bash
# Start a dedicated test postgres container, run migrations, run tests, cleanup
#
# Usage:
#   pnpm test              # Run all tests with database
#   pnpm test -- --watch   # Run tests in watch mode

COMPOSE_FILE="docker-compose.test.yml"
TEST_DB_URL="postgresql://user:password@localhost:5433/pagespace_test"

cleanup() {
  echo ""
  echo "Cleaning up test container..."
  docker compose -f "$COMPOSE_FILE" down --volumes 2>/dev/null
}

# Always cleanup on exit
trap cleanup EXIT

echo "Starting test PostgreSQL container..."
docker compose -f "$COMPOSE_FILE" up -d postgres-test || exit 1

echo "Waiting for PostgreSQL to be ready..."
until docker compose -f "$COMPOSE_FILE" exec -T postgres-test pg_isready -U user -q 2>/dev/null; do
  sleep 1
done

echo "Running database migrations..."
DATABASE_URL="$TEST_DB_URL" pnpm db:migrate || exit 1

echo "Running tests..."
DATABASE_URL="$TEST_DB_URL" \
JWT_SECRET=test-secret-key-minimum-32-characters-long-for-testing \
JWT_ISSUER=pagespace-test \
JWT_AUDIENCE=pagespace-test-users \
CSRF_SECRET=test-csrf-secret-minimum-32-characters-long-for-testing-purposes \
ENCRYPTION_KEY=test-encryption-key-32-chars-minimum-required-length \
ENCRYPTION_SALT=test-encryption-salt-for-backward-compatibility \
REALTIME_BROADCAST_SECRET=test-realtime-broadcast-secret-32-chars-minimum-length \
pnpm test:turbo --continue "$@"

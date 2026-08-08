#!/bin/bash
# Start a dedicated test postgres container, run migrations, run tests, cleanup
#
# Usage:
#   bun run test              # Run all tests with database
#   bun run test -- --watch   # Run tests in watch mode

COMPOSE_FILE="docker-compose.test.yml"
TEST_DB_URL="postgresql://user:password@localhost:5433/pagespace_test"

# The container has a fixed name (pagespace-postgres-test) shared across every
# checkout/worktree of this repo, but compose scopes ownership by project
# directory — so when another checkout created the container, `docker compose
# up` here fails with a name conflict on any clean worktree. In that case
# reuse the existing container by name and leave it running on exit (tearing
# it down would yank the DB out from under the checkout that owns it).
REUSED_EXISTING=0

cleanup() {
  if [ "$REUSED_EXISTING" -eq 1 ]; then
    echo ""
    echo "Leaving shared test container running (owned by another checkout)."
    return
  fi
  echo ""
  echo "Cleaning up test container..."
  docker compose -f "$COMPOSE_FILE" down --volumes 2>/dev/null
}

# Always cleanup on exit
trap cleanup EXIT

echo "Starting test PostgreSQL container..."
if ! docker compose -f "$COMPOSE_FILE" up -d postgres-test 2>/dev/null; then
  REUSED_EXISTING=1
  echo "Compose could not start it (name conflict with another checkout's container) — reusing pagespace-postgres-test..."
  docker start pagespace-postgres-test >/dev/null || {
    echo "Could not start the test Postgres container. Is Docker running?"
    echo "If a broken container lingers: docker rm -f pagespace-postgres-test"
    exit 1
  }
fi

echo "Waiting for PostgreSQL to be ready..."
until docker exec pagespace-postgres-test pg_isready -U user -q 2>/dev/null; do
  sleep 1
done

echo "Running database migrations..."
DATABASE_URL="$TEST_DB_URL" bun run db:migrate || exit 1

echo "Running tests..."
DATABASE_URL="$TEST_DB_URL" \
CSRF_SECRET=test-csrf-secret-minimum-32-characters-long-for-testing-purposes \
ENCRYPTION_KEY=test-encryption-key-32-chars-minimum-required-length \
REALTIME_BROADCAST_SECRET=test-realtime-broadcast-secret-32-chars-minimum-length \
bun run test:turbo --concurrency=1 --continue "$@"

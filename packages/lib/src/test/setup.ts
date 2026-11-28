/**
 * Vitest setup file - runs before all tests
 * Sets required environment variables for testing
 */

// Encryption environment variables
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-chars-minimum-required-length'

// CSRF protection environment variables
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret-minimum-32-characters-long-for-testing-purposes'

// Real-time broadcast authentication
process.env.REALTIME_BROADCAST_SECRET = process.env.REALTIME_BROADCAST_SECRET || 'test-realtime-broadcast-secret-32-chars-minimum-length'

// Database connection (for integration tests)
// Note: Integration tests require a running PostgreSQL instance
// See .env.test.example for setup instructions
if (!process.env.DATABASE_URL) {
  // Default to test database if not specified
  process.env.DATABASE_URL = 'postgresql://localhost:5432/pagespace_test'
}

// File storage paths for file processor tests
process.env.FILE_STORAGE_PATH = process.env.FILE_STORAGE_PATH || '/tmp/pagespace-test-files'
process.env.PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://localhost:3003'

// Realtime service URL
process.env.INTERNAL_REALTIME_URL = process.env.INTERNAL_REALTIME_URL || 'http://localhost:3001'

// Every test file runs in ONE long-lived fork (vitest.config.ts singleFork), so
// globalThis is shared across files: a file that swaps global.fetch for a mock
// leaks it into whichever file runs next, and the order shifts as files change.
// Capture the real fetch on the first file and hand it back to every file.
const fetchStore = globalThis as typeof globalThis & { __pagespaceRealFetch?: typeof fetch };
fetchStore.__pagespaceRealFetch ??= globalThis.fetch;
globalThis.fetch = fetchStore.__pagespaceRealFetch;

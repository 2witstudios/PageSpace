/**
 * Vitest setup file - runs before all tests
 * Sets required environment variables for testing
 */

// JWT authentication environment variables
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-minimum-32-characters-long-for-testing'
process.env.JWT_ISSUER = process.env.JWT_ISSUER || 'pagespace-test'
process.env.JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'pagespace-test-users'

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

// Redis configuration (for security-redis tests)
// If REDIS_URL is provided (e.g., in CI), use it for all Redis clients
if (!process.env.REDIS_URL) {
  // Redis is optional for tests - permission cache will use memory-only mode
  process.env.REDIS_URL = ''
}

// Security Redis URLs - required for security-redis tests
// These use separate databases on the same Redis instance
if (process.env.REDIS_URL && !process.env.REDIS_SESSION_URL) {
  process.env.REDIS_SESSION_URL = process.env.REDIS_URL.replace(/\/\d*$/, '/0') || `${process.env.REDIS_URL}/0`
}
if (process.env.REDIS_URL && !process.env.REDIS_RATE_LIMIT_URL) {
  process.env.REDIS_RATE_LIMIT_URL = process.env.REDIS_URL.replace(/\/\d*$/, '/1') || `${process.env.REDIS_URL}/1`
}

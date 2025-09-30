import '@testing-library/jest-dom'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Cleanup after each test
afterEach(() => {
  cleanup()
})

// Mock Next.js router
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}))

// Mock environment variables
process.env.JWT_SECRET = 'test-secret-key-minimum-32-characters-long'
process.env.JWT_ISSUER = 'pagespace-test'
process.env.JWT_AUDIENCE = 'pagespace-test-users'
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/pagespace_test'
import { vi } from 'vitest';

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
  redirect: vi.fn(),
}));

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/pagespace_test';
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret-key-minimum-32-characters';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-key-minimum-32-chars';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-minimum-32-chars-long';

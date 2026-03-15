/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for POST /api/admin/users/create
//
// Tests admin user creation endpoint. Uses withAdminAuth wrapper.
// ============================================================================

let mockAdminUser: { id: string; role: string; tokenVersion: number; adminRoleVersion: number; authTransport: string } | null = null;

vi.mock('@/lib/auth/auth', () => ({
  withAdminAuth: vi.fn((handler: any) => {
    return async (request: Request) => {
      if (!mockAdminUser) {
        return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
      }
      return handler(mockAdminUser, request);
    };
  }),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    })),
  },
  users: { email: 'email' },
  userAiSettings: {},
  eq: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed_password'),
  },
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('generated_id'),
}));

vi.mock('@pagespace/lib/auth', () => ({
  BCRYPT_COST: 10,
}));

vi.mock('@pagespace/lib', () => ({
  isOnPrem: vi.fn(() => false),
  getOnPremUserDefaults: vi.fn(() => ({ subscriptionTier: 'pro' })),
  getOnPremOllamaSettings: vi.fn(() => ({ provider: 'ollama', baseUrl: 'http://localhost:11434' })),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { POST } from '../route';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { isOnPrem } from '@pagespace/lib';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

// ============================================================================
// Test Helpers
// ============================================================================

const setAdminAuth = (id = 'admin_1') => {
  mockAdminUser = { id, role: 'admin', tokenVersion: 1, adminRoleVersion: 0, authTransport: 'cookie' };
};

const setNoAuth = () => {
  mockAdminUser = null;
};

const createRequest = (body: object) => {
  return new Request('https://example.com/api/admin/users/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const validUserData = {
  name: 'Test User',
  email: 'test@example.com',
  password: 'SecurePassword1',
};

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/admin/users/create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminAuth();
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as any);
    // Re-set db.insert mock after clearAllMocks (which clears implementations from vi.mock factory)
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  describe('authentication & authorization', () => {
    it('should return 403 when not an admin', async () => {
      setNoAuth();

      const response = await POST(createRequest(validUserData));

      expect(response.status).toBe(403);
    });

    it('should allow admin access', async () => {
      const response = await POST(createRequest(validUserData));

      expect(response.status).toBe(201);
    });
  });

  describe('validation', () => {
    it('should return 400 when name is missing', async () => {
      const response = await POST(createRequest({ email: 'test@test.com', password: 'SecurePassword1' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 when email is invalid', async () => {
      const response = await POST(createRequest({ name: 'Test', email: 'invalid', password: 'SecurePassword1' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 when password is too short', async () => {
      const response = await POST(createRequest({ name: 'Test', email: 'test@test.com', password: 'Short1' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 when password missing uppercase', async () => {
      const response = await POST(createRequest({ name: 'Test', email: 'test@test.com', password: 'alllowercase1' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 when password missing lowercase', async () => {
      const response = await POST(createRequest({ name: 'Test', email: 'test@test.com', password: 'ALLUPPERCASE1' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 when password missing number', async () => {
      const response = await POST(createRequest({ name: 'Test', email: 'test@test.com', password: 'NoNumbersHere' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });
  });

  describe('duplicate detection', () => {
    it('should return 409 when user email already exists', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ id: 'existing_user' } as any);

      const response = await POST(createRequest(validUserData));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('A user with this email already exists');
    });
  });

  describe('success', () => {
    it('should create user and return 201', async () => {
      const response = await POST(createRequest(validUserData));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.userId).toBe('generated_id');
      expect(body.message).toContain('test@example.com');
    });

    it('should normalize email to lowercase', async () => {
      const response = await POST(createRequest({ ...validUserData, email: 'TEST@Example.COM' }));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.message).toContain('test@example.com');
    });

    it('should provision getting started drive', async () => {
      await POST(createRequest(validUserData));

      expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('generated_id');
    });

    it('should accept role parameter', async () => {
      const response = await POST(createRequest({ ...validUserData, role: 'admin' }));

      expect(response.status).toBe(201);
    });

    it('should log user creation', async () => {
      await POST(createRequest(validUserData));

      expect(loggers.api.info).toHaveBeenCalledWith(
        'Admin created user account',
        expect.objectContaining({
          adminId: 'admin_1',
          newUserId: 'generated_id',
        })
      );
    });
  });

  describe('on-prem behavior', () => {
    it('should create Ollama settings on-prem', async () => {
      vi.mocked(isOnPrem).mockReturnValue(true);

      await POST(createRequest(validUserData));

      // db.insert should be called at least twice: once for users, once for aiSettings
      expect(db.insert).toHaveBeenCalledTimes(2);
    });

    it('should not create Ollama settings when not on-prem', async () => {
      vi.mocked(isOnPrem).mockReturnValue(false);

      await POST(createRequest(validUserData));

      // db.insert only called once for users
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database insert fails', async () => {
      vi.mocked(db.insert).mockImplementation(() => {
        throw new Error('DB error');
      });

      const response = await POST(createRequest(validUserData));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create user');
    });

    it('should handle getting started drive provisioning failure gracefully', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockRejectedValue(new Error('Provisioning failed'));

      const response = await POST(createRequest(validUserData));

      // Should still succeed - provisioning failure is non-fatal
      expect(response.status).toBe(201);
      expect(loggers.api.warn).toHaveBeenCalled();
    });
  });
});

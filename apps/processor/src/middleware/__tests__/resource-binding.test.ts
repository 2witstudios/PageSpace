import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const VALID_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

vi.mock('@pagespace/lib/logger-config', () => ({
  loggers: {
    security: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('../../cache/content-store', () => ({
  isValidContentHash: (hash: string) => /^[a-f0-9]{64}$/i.test(hash),
}));

import type { EnforcedAuthContext } from '../auth';
import { requireResourceBinding, requirePageBinding } from '../resource-binding';

function createAuth(overrides: Partial<EnforcedAuthContext> = {}): EnforcedAuthContext {
  return {
    userId: 'user-1',
    userRole: 'user',
    resourceBinding: undefined,
    driveId: undefined,
    hasScope: () => true,
    isAdmin: () => false,
    isBoundToResource: () => !!overrides.resourceBinding,
    ...overrides,
  } as unknown as EnforcedAuthContext;
}

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    auth: undefined,
    params: {},
    body: {},
    path: '/test',
    method: 'GET',
    ...overrides,
  } as unknown as Request;
}

function createMockResponse(): { res: Response; statusCode: number | null; jsonBody: unknown } {
  let statusCode: number | null = null;
  let jsonBody: unknown = null;

  const res = {
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      jsonBody = body;
      return res;
    }),
  } as unknown as Response;

  return { res, get statusCode() { return statusCode; }, get jsonBody() { return jsonBody; } };
}

describe('requireResourceBinding', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn();
  });

  describe('when no auth context', () => {
    it('calls next() to let route handler deal with it', () => {
      const middleware = requireResourceBinding('params');
      const req = createMockRequest();
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('when unbound token', () => {
    it('calls next() to let authorization service check permissions', () => {
      const middleware = requireResourceBinding('params');
      const req = createMockRequest({
        auth: createAuth(),
        params: { contentHash: VALID_HASH },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('when file-bound token', () => {
    it('calls next() when contentHash matches binding', () => {
      const middleware = requireResourceBinding('params');
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'file', id: VALID_HASH },
        }),
        params: { contentHash: VALID_HASH },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('returns 403 when contentHash does NOT match binding', () => {
      const middleware = requireResourceBinding('params');
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'file', id: OTHER_HASH },
        }),
        params: { contentHash: VALID_HASH },
      });
      const { res, statusCode, jsonBody } = createMockResponse();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode).toBe(403);
      expect(jsonBody).toEqual({ error: 'Access denied: token is bound to a different file' });
    });

    it('handles case-insensitive hash comparison', () => {
      const middleware = requireResourceBinding('params');
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'file', id: VALID_HASH.toUpperCase() },
        }),
        params: { contentHash: VALID_HASH.toLowerCase() },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('when page-bound token', () => {
    it('calls next() to defer to authorization service', () => {
      const middleware = requireResourceBinding('params');
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'page', id: 'page-1' },
        }),
        params: { contentHash: VALID_HASH },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('when drive-bound token', () => {
    it('calls next() to defer to authorization service', () => {
      const middleware = requireResourceBinding('params');
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'drive', id: 'drive-1' },
        }),
        params: { contentHash: VALID_HASH },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('contentHash source', () => {
    it('reads contentHash from params when source is params', () => {
      const middleware = requireResourceBinding('params');
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'file', id: VALID_HASH },
        }),
        params: { contentHash: VALID_HASH },
        body: { contentHash: OTHER_HASH },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('reads contentHash from body when source is body', () => {
      const middleware = requireResourceBinding('body');
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'file', id: VALID_HASH },
        }),
        params: { contentHash: OTHER_HASH },
        body: { contentHash: VALID_HASH },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('when contentHash is missing', () => {
    it('calls next() to let route handler validate', () => {
      const middleware = requireResourceBinding('params');
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'file', id: VALID_HASH },
        }),
        params: {},
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('when contentHash is invalid format', () => {
    it('calls next() to let route handler return proper validation error', () => {
      const middleware = requireResourceBinding('params');
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'file', id: VALID_HASH },
        }),
        params: { contentHash: 'invalid-hash' },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});

describe('requirePageBinding', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn();
  });

  describe('when no auth context', () => {
    it('calls next()', () => {
      const middleware = requirePageBinding();
      const req = createMockRequest();
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('when unbound token', () => {
    it('calls next()', () => {
      const middleware = requirePageBinding();
      const req = createMockRequest({
        auth: createAuth(),
        params: { pageId: 'page-1' },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('when page-bound token', () => {
    it('calls next() when pageId matches binding', () => {
      const middleware = requirePageBinding();
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'page', id: 'page-1' },
        }),
        params: { pageId: 'page-1' },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('returns 403 when pageId does NOT match binding', () => {
      const middleware = requirePageBinding();
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'page', id: 'page-1' },
        }),
        params: { pageId: 'page-2' },
      });
      const { res, statusCode, jsonBody } = createMockResponse();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode).toBe(403);
      expect(jsonBody).toEqual({ error: 'Access denied: token is bound to a different page' });
    });
  });

  describe('when file-bound token', () => {
    it('calls next() to defer to authorization service', () => {
      const middleware = requirePageBinding();
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'file', id: VALID_HASH },
        }),
        params: { pageId: 'page-1' },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('when drive-bound token', () => {
    it('calls next() to defer to authorization service', () => {
      const middleware = requirePageBinding();
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'drive', id: 'drive-1' },
        }),
        params: { pageId: 'page-1' },
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('when pageId is missing', () => {
    it('calls next()', () => {
      const middleware = requirePageBinding();
      const req = createMockRequest({
        auth: createAuth({
          resourceBinding: { type: 'page', id: 'page-1' },
        }),
        params: {},
      });
      const { res } = createMockResponse();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});

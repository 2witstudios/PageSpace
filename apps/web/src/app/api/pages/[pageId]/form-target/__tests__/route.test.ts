import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * /api/pages/[pageId]/form-target Endpoint Contract Tests
 *
 * Authenticated Forms settings API for a Canvas page (`pageId` here is the
 * CANVAS page's id, not the target Sheet's). Mirrors the auth pattern used by
 * the sibling publish route: authenticateRequestWithOptions -> MCP scope
 * check -> canPrincipalEditPage.
 */

const mockAuthenticate = vi.hoisted(() => vi.fn());
const mockCheckMCPPageScope = vi.hoisted(() => vi.fn());
const mockCanPrincipalEditPage = vi.hoisted(() => vi.fn());
const mockAuditRequest = vi.hoisted(() => vi.fn());
const mockGetFormTargetByCanvasPageId = vi.hoisted(() => vi.fn());
const mockCreateFormTarget = vi.hoisted(() => vi.fn());
const mockUpdateFormTargetFields = vi.hoisted(() => vi.fn());
const mockUpdateFormTargetStatus = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mockAuthenticate,
  isAuthError: (result: { error?: unknown }) => 'error' in result,
  checkMCPPageScope: mockCheckMCPPageScope,
  canPrincipalEditPage: mockCanPrincipalEditPage,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: mockAuditRequest,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/services/api/form-target-service', async () => {
  const actual = await vi.importActual<typeof import('@/services/api/form-target-service')>(
    '@/services/api/form-target-service'
  );
  return {
    ...actual,
    getFormTargetByCanvasPageId: mockGetFormTargetByCanvasPageId,
    createFormTarget: mockCreateFormTarget,
    updateFormTargetFields: mockUpdateFormTargetFields,
    updateFormTargetStatus: mockUpdateFormTargetStatus,
  };
});

import { GET, POST, PATCH, DELETE } from '../route';

const fields = [
  { name: 'name', label: 'Name', type: 'text' as const, required: true },
  { name: 'email', label: 'Email', type: 'email' as const, required: true },
];

const storedFormTarget = {
  id: 'ft-1',
  tokenHash: 'sensitive-hash',
  tokenPrefix: 'pft_abc',
  pageId: 'sheet-1',
  canvasPageId: 'canvas-1',
  driveId: 'drive-1',
  action: 'sheet:append',
  fields,
  headerRow: 1,
  nextRow: 2,
  status: 'active',
  createdBy: 'user-1',
  submissionCount: 0,
};

const params = () => ({ params: Promise.resolve({ pageId: 'canvas-1' }) });

const createRequest = (method: string, body?: object) =>
  new Request('http://localhost/api/pages/canvas-1/form-target', {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });

describe('/api/pages/[pageId]/form-target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEB_APP_URL = 'https://app.pagespace.ai';
    mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
    mockCheckMCPPageScope.mockResolvedValue(null);
    mockCanPrincipalEditPage.mockResolvedValue(true);
  });

  describe('GET', () => {
    it('returns 403 when the actor cannot edit the page', async () => {
      mockCanPrincipalEditPage.mockResolvedValue(false);

      const response = await GET(createRequest('GET'), params());
      expect(response.status).toBe(403);
    });

    it('returns { formTarget: null } when no target is embedded in this Canvas page', async () => {
      mockGetFormTargetByCanvasPageId.mockResolvedValue(null);

      const response = await GET(createRequest('GET'), params());
      const body = await response.json();
      expect(body).toEqual({ formTarget: null });
    });

    it('returns the target with tokenHash/tokenPrefix stripped', async () => {
      mockGetFormTargetByCanvasPageId.mockResolvedValue(storedFormTarget);

      const response = await GET(createRequest('GET'), params());
      const body = await response.json();

      expect(body.formTarget.id).toBe('ft-1');
      expect(body.formTarget.tokenHash).toBeUndefined();
      expect(body.formTarget.tokenPrefix).toBeUndefined();
    });
  });

  describe('POST', () => {
    it('returns 403 when the actor cannot edit the page', async () => {
      mockCanPrincipalEditPage.mockResolvedValue(false);

      const response = await POST(createRequest('POST', { sheetPageId: 'sheet-1', fields }), params());
      expect(response.status).toBe(403);
    });

    it('returns 400 for an invalid body', async () => {
      const response = await POST(createRequest('POST', { sheetPageId: 'sheet-1', fields: [] }), params());
      expect(response.status).toBe(400);
    });

    it('creates the form target scoped to this Canvas page and returns the embeddable HTML', async () => {
      mockCreateFormTarget.mockResolvedValue({
        token: 'pft_realtoken',
        formTarget: { ...storedFormTarget, id: 'ft-new' },
      });

      const response = await POST(createRequest('POST', { sheetPageId: 'sheet-1', fields }), params());
      const body = await response.json();

      expect(mockCreateFormTarget).toHaveBeenCalledWith(
        expect.objectContaining({ sheetPageId: 'sheet-1', fields, createdBy: 'user-1', canvasPageId: 'canvas-1' })
      );
      expect(body.formTargetId).toBe('ft-new');
      expect(body.formHtml).toContain('name="name"');
      expect(body.submitUrl).toContain('pft_realtoken');
    });

    it('returns 400 when the sheet already has an active form target', async () => {
      const { FormTargetAlreadyActiveError } = await import('@/services/api/form-target-service');
      mockCreateFormTarget.mockRejectedValue(new FormTargetAlreadyActiveError('already active'));

      const response = await POST(createRequest('POST', { sheetPageId: 'sheet-1', fields }), params());
      expect(response.status).toBe(400);
    });
  });

  describe('PATCH', () => {
    it('returns 404 when no form target exists for this Canvas page', async () => {
      mockGetFormTargetByCanvasPageId.mockResolvedValue(null);

      const response = await PATCH(
        createRequest('PATCH', { op: 'set-status', status: 'paused' }),
        params()
      );
      expect(response.status).toBe(404);
    });

    it('routes set-status to updateFormTargetStatus', async () => {
      mockGetFormTargetByCanvasPageId.mockResolvedValue(storedFormTarget);
      mockUpdateFormTargetStatus.mockResolvedValue({ ...storedFormTarget, status: 'paused' });

      const response = await PATCH(
        createRequest('PATCH', { op: 'set-status', status: 'paused', reason: 'spam' }),
        params()
      );

      expect(mockUpdateFormTargetStatus).toHaveBeenCalledWith({
        formTargetId: 'ft-1',
        status: 'paused',
        statusReason: 'spam',
      });
      const body = await response.json();
      expect(body.formTarget.status).toBe('paused');
    });

    it('routes add-field to updateFormTargetFields and returns a standalone field snippet', async () => {
      mockGetFormTargetByCanvasPageId.mockResolvedValue(storedFormTarget);
      const newField = { name: 'phone', label: 'Phone', type: 'text' as const, required: false };
      mockUpdateFormTargetFields.mockResolvedValue({ ...storedFormTarget, fields: [...fields, newField] });

      const response = await PATCH(createRequest('PATCH', { op: 'add-field', field: newField }), params());
      const body = await response.json();

      expect(mockUpdateFormTargetFields).toHaveBeenCalledWith({
        formTargetId: 'ft-1',
        mutation: { op: 'add-field', field: newField },
        mutationContext: { userId: 'user-1' },
      });
      expect(body.fieldSnippet).toContain('name="phone"');
    });

    it('does not include a fieldSnippet for archive-field', async () => {
      mockGetFormTargetByCanvasPageId.mockResolvedValue(storedFormTarget);
      mockUpdateFormTargetFields.mockResolvedValue(storedFormTarget);

      const response = await PATCH(createRequest('PATCH', { op: 'archive-field', index: 0 }), params());
      const body = await response.json();

      expect(body.fieldSnippet).toBeUndefined();
    });

    it('returns 400 when the field-index is out of range', async () => {
      const { FormTargetFieldIndexError } = await import('@/services/api/form-target-service');
      mockGetFormTargetByCanvasPageId.mockResolvedValue(storedFormTarget);
      mockUpdateFormTargetFields.mockRejectedValue(new FormTargetFieldIndexError('no field at index'));

      const response = await PATCH(createRequest('PATCH', { op: 'archive-field', index: 99 }), params());
      expect(response.status).toBe(400);
    });

    it('returns 400 for a malformed body', async () => {
      mockGetFormTargetByCanvasPageId.mockResolvedValue(storedFormTarget);

      const response = await PATCH(createRequest('PATCH', { op: 'not-a-real-op' }), params());
      expect(response.status).toBe(400);
    });
  });

  describe('DELETE', () => {
    it('returns 404 when no form target exists for this Canvas page', async () => {
      mockGetFormTargetByCanvasPageId.mockResolvedValue(null);

      const response = await DELETE(createRequest('DELETE'), params());
      expect(response.status).toBe(404);
    });

    it('archives the whole target', async () => {
      mockGetFormTargetByCanvasPageId.mockResolvedValue(storedFormTarget);
      mockUpdateFormTargetStatus.mockResolvedValue({ ...storedFormTarget, status: 'archived' });

      const response = await DELETE(createRequest('DELETE'), params());
      const body = await response.json();

      expect(mockUpdateFormTargetStatus).toHaveBeenCalledWith({ formTargetId: 'ft-1', status: 'archived' });
      expect(body).toEqual({ archived: true });
    });
  });
});

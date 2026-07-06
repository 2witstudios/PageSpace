import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * /api/pages/[pageId]/form-target Endpoint Contract Tests
 *
 * Authenticated Forms settings API for a Canvas page (`pageId` here is the
 * CANVAS page's id, not the target Sheet's). Mirrors the auth pattern used by
 * the sibling publish route: authenticateRequestWithOptions -> MCP scope
 * check -> canPrincipalEditPage. This route only manages the DB grant — all
 * HTML markup work (detecting/wiring/deleting <form> tags) happens
 * client-side, so POST/PATCH/DELETE bodies don't carry any HTML.
 */

const mockAuthenticate = vi.hoisted(() => vi.fn());
const mockCheckMCPPageScope = vi.hoisted(() => vi.fn());
const mockCanPrincipalEditPage = vi.hoisted(() => vi.fn());
const mockAuditRequest = vi.hoisted(() => vi.fn());
const mockGetFormTargetsByCanvasPageId = vi.hoisted(() => vi.fn());
const mockGetFormTargetById = vi.hoisted(() => vi.fn());
const mockCreateFormTarget = vi.hoisted(() => vi.fn());
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
    getFormTargetsByCanvasPageId: mockGetFormTargetsByCanvasPageId,
    getFormTargetById: mockGetFormTargetById,
    createFormTarget: mockCreateFormTarget,
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

const createRequest = (method: string, body?: object, search?: string) =>
  new Request(`http://localhost/api/pages/canvas-1/form-target${search ?? ''}`, {
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

    it('returns an empty array when no target is wired to this Canvas page', async () => {
      mockGetFormTargetsByCanvasPageId.mockResolvedValue([]);

      const response = await GET(createRequest('GET'), params());
      const body = await response.json();
      expect(body).toEqual({ formTargets: [] });
    });

    it('returns every target wired to this page with tokenHash/tokenPrefix stripped', async () => {
      mockGetFormTargetsByCanvasPageId.mockResolvedValue([
        storedFormTarget,
        { ...storedFormTarget, id: 'ft-2' },
      ]);

      const response = await GET(createRequest('GET'), params());
      const body = await response.json();

      expect(body.formTargets).toHaveLength(2);
      expect(body.formTargets[0].id).toBe('ft-1');
      expect(body.formTargets[0].tokenHash).toBeUndefined();
      expect(body.formTargets[0].tokenPrefix).toBeUndefined();
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

    it('creates the form target scoped to this Canvas page and returns the submit URL (no formHtml)', async () => {
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
      expect(body.submitUrl).toContain('pft_realtoken');
      expect(body.formHtml).toBeUndefined();
    });

    it('returns 400 when the sheet already has an active form target', async () => {
      const { FormTargetAlreadyActiveError } = await import('@/services/api/form-target-service');
      mockCreateFormTarget.mockRejectedValue(new FormTargetAlreadyActiveError('already active'));

      const response = await POST(createRequest('POST', { sheetPageId: 'sheet-1', fields }), params());
      expect(response.status).toBe(400);
    });

    it('never mutates anything when WEB_APP_URL is unconfigured', async () => {
      delete process.env.WEB_APP_URL;

      const response = await POST(createRequest('POST', { sheetPageId: 'sheet-1', fields }), params());

      expect(response.status).toBe(500);
      expect(mockCreateFormTarget).not.toHaveBeenCalled();
    });
  });

  describe('PATCH', () => {
    it('returns 403 when the actor cannot edit the page', async () => {
      mockCanPrincipalEditPage.mockResolvedValue(false);

      const response = await PATCH(
        createRequest('PATCH', { formTargetId: 'ft-1', status: 'paused' }),
        params()
      );
      expect(response.status).toBe(403);
    });

    it('returns 400 for a malformed body', async () => {
      const response = await PATCH(createRequest('PATCH', { formTargetId: 'ft-1' }), params());
      expect(response.status).toBe(400);
    });

    it('rejects status "archived" — archiving must go through DELETE', async () => {
      const response = await PATCH(
        createRequest('PATCH', { formTargetId: 'ft-1', status: 'archived' }),
        params()
      );
      expect(response.status).toBe(400);
    });

    it('returns 404 when the target does not belong to this Canvas page', async () => {
      mockGetFormTargetById.mockResolvedValue({ ...storedFormTarget, canvasPageId: 'some-other-canvas-page' });

      const response = await PATCH(
        createRequest('PATCH', { formTargetId: 'ft-1', status: 'paused' }),
        params()
      );
      expect(response.status).toBe(404);
    });

    it('returns 404 when the target does not exist', async () => {
      mockGetFormTargetById.mockResolvedValue(null);

      const response = await PATCH(
        createRequest('PATCH', { formTargetId: 'missing', status: 'paused' }),
        params()
      );
      expect(response.status).toBe(404);
    });

    it('updates the status of a target scoped to this Canvas page', async () => {
      mockGetFormTargetById.mockResolvedValue(storedFormTarget);
      mockUpdateFormTargetStatus.mockResolvedValue({ ...storedFormTarget, status: 'paused' });

      const response = await PATCH(
        createRequest('PATCH', { formTargetId: 'ft-1', status: 'paused', reason: 'spam' }),
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

    it('returns 400 when reactivating an archived target', async () => {
      const { FormTargetArchivedError } = await import('@/services/api/form-target-service');
      mockGetFormTargetById.mockResolvedValue({ ...storedFormTarget, status: 'archived' });
      mockUpdateFormTargetStatus.mockRejectedValue(new FormTargetArchivedError('archived — cannot be reversed'));

      const response = await PATCH(
        createRequest('PATCH', { formTargetId: 'ft-1', status: 'active' }),
        params()
      );
      expect(response.status).toBe(400);
    });
  });

  describe('DELETE', () => {
    it('returns 400 when formTargetId is missing', async () => {
      const response = await DELETE(createRequest('DELETE'), params());
      expect(response.status).toBe(400);
    });

    it('returns 404 when the target does not belong to this Canvas page', async () => {
      mockGetFormTargetById.mockResolvedValue({ ...storedFormTarget, canvasPageId: 'some-other-canvas-page' });

      const response = await DELETE(createRequest('DELETE', undefined, '?formTargetId=ft-1'), params());
      expect(response.status).toBe(404);
    });

    it('archives the target', async () => {
      mockGetFormTargetById.mockResolvedValue(storedFormTarget);
      mockUpdateFormTargetStatus.mockResolvedValue({ ...storedFormTarget, status: 'archived' });

      const response = await DELETE(createRequest('DELETE', undefined, '?formTargetId=ft-1'), params());
      const body = await response.json();

      expect(mockUpdateFormTargetStatus).toHaveBeenCalledWith({ formTargetId: 'ft-1', status: 'archived' });
      expect(body).toEqual({ archived: true });
    });
  });
});

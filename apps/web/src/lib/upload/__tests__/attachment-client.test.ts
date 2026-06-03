import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchWithAuth = vi.fn();
const mockComputeContentHash = vi.fn();
const mockUploadToTigris = vi.fn();

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: (...a: unknown[]) => mockFetchWithAuth(...a) }));
vi.mock('../content-hash', () => ({ computeContentHash: (...a: unknown[]) => mockComputeContentHash(...a) }));
vi.mock('../orchestrator', () => ({ uploadToTigris: (...a: unknown[]) => mockUploadToTigris(...a) }));

import { uploadAttachment, attachmentUploadErrorMessage } from '../attachment-client';

const HASH = 'a'.repeat(64);
const FILE = { name: 'photo.png', type: 'image/png', size: 1024 } as unknown as File;
const BASE = '/api/channels/page-1/upload';

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const ATTACHMENT = { id: HASH, originalName: 'photo.png', size: 1024, mimeType: 'image/png', contentHash: HASH };

describe('attachmentUploadErrorMessage', () => {
  it('maps 413 to a too-large message', () => {
    expect(attachmentUploadErrorMessage(413)).toBe('File too large');
  });
  it('maps 429 to a too-many message', () => {
    expect(attachmentUploadErrorMessage(429)).toMatch(/too many/i);
  });
  it('maps 403 to a permission message', () => {
    expect(attachmentUploadErrorMessage(403)).toMatch(/permission/i);
  });
  it('prefers the server-provided error when present', () => {
    expect(attachmentUploadErrorMessage(413, 'Exceeds free tier 50MB')).toBe('Exceeds free tier 50MB');
  });
});

describe('uploadAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeContentHash.mockResolvedValue(HASH);
    mockUploadToTigris.mockResolvedValue(undefined);
  });

  it('runs presign → PUT → complete and returns the attachment', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(jsonRes(200, { url: 'https://tigris/put', jobId: 'job-1', key: 'k' })) // presign
      .mockResolvedValueOnce(jsonRes(200, { success: true, file: ATTACHMENT })); // complete

    const result = await uploadAttachment(BASE, FILE);
    expect(result).toEqual({ ok: true, attachment: ATTACHMENT });
    expect(mockUploadToTigris).toHaveBeenCalledWith('https://tigris/put', FILE);
    expect(mockFetchWithAuth).toHaveBeenNthCalledWith(1, `${BASE}/presign`, expect.any(Object));
    expect(mockFetchWithAuth).toHaveBeenNthCalledWith(2, `${BASE}/complete`, expect.any(Object));
  });

  it('skips the PUT on a dedup hit but still completes', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(jsonRes(200, { alreadyExists: true, jobId: 'job-1', key: 'k' }))
      .mockResolvedValueOnce(jsonRes(200, { success: true, file: ATTACHMENT }));

    const result = await uploadAttachment(BASE, FILE);
    expect(result.ok).toBe(true);
    expect(mockUploadToTigris).not.toHaveBeenCalled();
  });

  it('returns a mapped error and never PUTs when presign fails', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(jsonRes(413, { error: 'too big' }));
    const result = await uploadAttachment(BASE, FILE);
    expect(result).toEqual({ ok: false, errorMessage: 'too big' });
    expect(mockUploadToTigris).not.toHaveBeenCalled();
  });

  it('cancels the slot when the PUT fails', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(jsonRes(200, { url: 'https://tigris/put', jobId: 'job-1', key: 'k' }))
      .mockResolvedValueOnce(jsonRes(200, { success: true })); // cancel call
    mockUploadToTigris.mockRejectedValue(new Error('network'));

    const result = await uploadAttachment(BASE, FILE);
    expect(result.ok).toBe(false);
    expect(mockFetchWithAuth).toHaveBeenNthCalledWith(2, `${BASE}/cancel`, expect.any(Object));
  });

  it('cancels the slot and maps the error when complete fails', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(jsonRes(200, { url: 'https://tigris/put', jobId: 'job-1', key: 'k' }))
      .mockResolvedValueOnce(jsonRes(422, { error: 'integrity failed' })) // complete
      .mockResolvedValueOnce(jsonRes(200, { success: true })); // cancel

    const result = await uploadAttachment(BASE, FILE);
    expect(result).toEqual({ ok: false, errorMessage: 'integrity failed' });
    expect(mockFetchWithAuth).toHaveBeenNthCalledWith(3, `${BASE}/cancel`, expect.any(Object));
  });
});

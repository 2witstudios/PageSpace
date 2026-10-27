import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../content-hash', () => ({
  computeContentHash: vi.fn().mockResolvedValue('d'.repeat(64)),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import {
  callPresign,
  callComplete,
  callCancel,
  uploadToTigris,
  uploadFileToS3,
} from '../orchestrator';
import { computeContentHash } from '../content-hash';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

function makeFile(name = 'photo.jpg', type = 'image/jpeg', size = 1024): File {
  return { name, type, size, arrayBuffer: async () => new ArrayBuffer(size) } as unknown as File;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const mockFetch = vi.mocked(fetchWithAuth);

// --- XHR mock --------------------------------------------------------------
class MockXHR {
  static instances: MockXHR[] = [];
  upload = { onprogress: null as ((e: { loaded: number; total: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 200;
  method = '';
  url = '';
  sentBody: unknown = null;
  headers: Record<string, string> = {};
  constructor() { MockXHR.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: unknown) {
    this.sentBody = body;
    queueMicrotask(() => {
      this.upload.onprogress?.({ loaded: 512, total: 1024 });
      this.upload.onprogress?.({ loaded: 1024, total: 1024 });
      this.onload?.();
    });
  }
}

const originalXHR = global.XMLHttpRequest;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeContentHash).mockResolvedValue('d'.repeat(64));
  MockXHR.instances = [];
  global.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
  global.XMLHttpRequest = originalXHR;
});

describe('callPresign', () => {
  it('POSTs the upload params and returns the parsed presign response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ url: 'https://t/put', jobId: 'job-1', key: 'files/x/original', expiresAt: 'soon' }),
    );

    const res = await callPresign({ contentHash: 'd'.repeat(64), driveId: 'drive-1', filename: 'a.jpg', mimeType: 'image/jpeg', fileSize: 1024 });

    expect(res.jobId).toBe('job-1');
    expect(mockFetch).toHaveBeenCalledWith('/api/upload/presign', expect.objectContaining({ method: 'POST' }));
  });

  it('throws when the presign request fails', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'too big' }, false, 413));
    await expect(
      callPresign({ contentHash: 'd'.repeat(64), driveId: 'd', filename: 'a', mimeType: 'image/jpeg', fileSize: 1 }),
    ).rejects.toThrow(/too big/);
  });
});

describe('uploadToTigris', () => {
  it('PUTs the file to the presigned URL and reports progress percentages', async () => {
    const progress: number[] = [];
    await uploadToTigris('https://tigris/put', makeFile(), (pct) => progress.push(pct));
    expect(MockXHR.instances[0].method).toBe('PUT');
    expect(MockXHR.instances[0].url).toBe('https://tigris/put');
    expect(progress).toEqual([50, 100]);
  });

  it('sets the Content-Type header to the file type', async () => {
    await uploadToTigris('https://tigris/put', makeFile('a.jpg', 'image/jpeg'));
    expect(MockXHR.instances[0].headers['Content-Type']).toBe('image/jpeg');
  });

  it('sends application/octet-stream for a MIME-less file so it matches the presigned signature', async () => {
    await uploadToTigris('https://tigris/put', makeFile('data', ''));
    expect(MockXHR.instances[0].headers['Content-Type']).toBe('application/octet-stream');
  });

  it('rejects when the PUT returns a non-2xx status', async () => {
    global.XMLHttpRequest = class extends MockXHR {
      send() { queueMicrotask(() => { this.status = 403; this.onload?.(); }); }
    } as unknown as typeof XMLHttpRequest;
    await expect(uploadToTigris('https://tigris/put', makeFile())).rejects.toThrow();
  });
});

describe('callComplete', () => {
  it('POSTs the completion params and returns the created page', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, page: { id: 'page-1' } }));
    const res = await callComplete({ jobId: 'job-1', contentHash: 'd'.repeat(64), driveId: 'drive-1', title: 'a.jpg', mimeType: 'image/jpeg', fileSize: 1024 });
    expect(res.page.id).toBe('page-1');
  });
});

describe('uploadFileToS3', () => {
  it('runs hash → presign → PUT → complete for a new file', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ url: 'https://t/put', jobId: 'job-1', key: 'k', expiresAt: 's' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, page: { id: 'page-1' } }));

    const page = await uploadFileToS3(makeFile(), { driveId: 'drive-1' });

    expect(computeContentHash).toHaveBeenCalled();
    expect(MockXHR.instances).toHaveLength(1); // PUT happened
    expect(page.id).toBe('page-1');
  });

  it('skips the PUT entirely when presign reports the file already exists', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ alreadyExists: true, jobId: 'job-1', key: 'k' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, page: { id: 'page-dedup' } }));

    const page = await uploadFileToS3(makeFile(), { driveId: 'drive-1' });

    expect(MockXHR.instances).toHaveLength(0); // no bytes transferred
    expect(page.id).toBe('page-dedup');
  });

  it('cancels the reserved slot when the PUT fails — no slot leak', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ url: 'https://t/put', jobId: 'job-99', key: 'k', expiresAt: 's' }))
      .mockResolvedValueOnce(jsonResponse({ success: true })); // the cancel call
    global.XMLHttpRequest = class extends MockXHR {
      send() { queueMicrotask(() => { this.onerror?.(); }); }
    } as unknown as typeof XMLHttpRequest;

    await expect(uploadFileToS3(makeFile(), { driveId: 'drive-1' })).rejects.toThrow();

    expect(mockFetch).toHaveBeenCalledWith('/api/upload/cancel', expect.objectContaining({ method: 'POST' }));
  });

  it('falls back to a default name and title when the file name is empty', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ url: 'https://t/put', jobId: 'job-1', key: 'k' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, page: { id: 'p' } }));

    await uploadFileToS3(makeFile('', 'text/plain'), { driveId: 'drive-1' });

    const presignBody = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    const completeBody = JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body);
    expect(presignBody.filename).toBe('Untitled');
    expect(completeBody.title).toBe('Untitled');
  });

  it('threads a trimmed title, position and afterNodeId through to /complete', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ url: 'https://t/put', jobId: 'job-1', key: 'k' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, page: { id: 'p' } }));

    await uploadFileToS3(makeFile('a.txt', 'text/plain'), {
      driveId: 'drive-1',
      parentId: 'parent-1',
      title: '  Custom  ',
      position: 'after',
      afterNodeId: 'sibling-1',
    });

    const completeBody = JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body);
    expect(completeBody).toMatchObject({
      title: 'Custom',
      parentId: 'parent-1',
      position: 'after',
      afterNodeId: 'sibling-1',
    });
  });
});

describe('callCancel', () => {
  it('POSTs the jobId to the cancel endpoint', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));
    await callCancel('job-1');
    expect(mockFetch).toHaveBeenCalledWith('/api/upload/cancel', expect.objectContaining({ method: 'POST' }));
  });

  it('never throws even if the cancel request fails — best-effort cleanup', async () => {
    mockFetch.mockRejectedValue(new Error('network'));
    await expect(callCancel('job-1')).resolves.toBeUndefined();
  });
});

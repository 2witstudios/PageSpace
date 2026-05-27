// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  buildAuthHeader,
  buildRecordingsUrl,
  encodeZoomUUID,
  buildZoomOAuthScopes,
  getRecordings,
  downloadTranscript,
} from '../zoom-api-client';

describe('buildAuthHeader', () => {
  it('returns Authorization Bearer header', () => {
    const header = buildAuthHeader('tok_abc123');
    expect(header).toEqual({ Authorization: 'Bearer tok_abc123' });
  });

  it('does not include token in any URL-like value', () => {
    const header = buildAuthHeader('secret_token');
    const headerString = JSON.stringify(header);
    expect(headerString).not.toContain('access_token=');
    expect(headerString).not.toContain('?secret_token');
  });
});

describe('encodeZoomUUID', () => {
  it('double-encodes a UUID starting with /', () => {
    const uuid = '/u3D+1234==';
    expect(encodeZoomUUID(uuid)).toBe(encodeURIComponent(encodeURIComponent(uuid)));
  });

  it('double-encodes a UUID containing //', () => {
    const uuid = 'abc//def==';
    expect(encodeZoomUUID(uuid)).toBe(encodeURIComponent(encodeURIComponent(uuid)));
  });

  it('single-encodes a normal UUID with no leading slash or double slash', () => {
    const uuid = 'abc+def=xyz';
    expect(encodeZoomUUID(uuid)).toBe(encodeURIComponent(uuid));
    expect(encodeZoomUUID(uuid)).not.toBe(encodeURIComponent(encodeURIComponent(uuid)));
  });
});

describe('buildZoomOAuthScopes', () => {
  it('returns a space-separated string containing all required scopes', () => {
    const parts = buildZoomOAuthScopes().split(' ');
    expect(parts).toContain('recording:read');
    expect(parts).toContain('user:read');
    expect(parts).toContain('meeting:write');
    expect(parts).toContain('meeting:read:search');
    expect(parts).toContain('meeting:read:assets');
    expect(parts).toContain('ai_companion:read:search');
    expect(parts).toContain('cloud_recording:read:list_user_recordings');
    expect(parts).toContain('cloud_recording:read:content');
  });

  it('does not include recording:read:admin (user-scoped app, not org-admin)', () => {
    expect(buildZoomOAuthScopes()).not.toContain('recording:read:admin');
  });
});

describe('buildRecordingsUrl', () => {
  it('uses the hardcoded api.zoom.us base', () => {
    const url = buildRecordingsUrl('some-uuid');
    expect(url).toContain('https://api.zoom.us/v2/');
  });

  it('includes the encoded meeting UUID in the path', () => {
    const url = buildRecordingsUrl('abc+def/xyz');
    expect(url).toContain(encodeURIComponent('abc+def/xyz'));
    expect(url).not.toContain('abc+def/xyz');
  });

  it('places uuid in the path segment, not a query param', () => {
    const url = buildRecordingsUrl('meeting-123');
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('api.zoom.us');
    expect(parsed.pathname).toContain('meeting-123');
    expect(parsed.search).toBe('');
  });

  it('path ends with /recordings', () => {
    const url = buildRecordingsUrl('meeting-123');
    expect(new URL(url).pathname).toMatch(/\/recordings$/);
  });

  it('double-encodes a UUID starting with / in the path', () => {
    const uuid = '/u3D+abc==';
    const url = buildRecordingsUrl(uuid);
    expect(url).toContain(encodeURIComponent(encodeURIComponent(uuid)));
  });
});

describe('getRecordings', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns success with data on 200 response', async () => {
    const mockData = {
      uuid: 'mtg-uuid',
      topic: 'Team Standup',
      start_time: '2024-01-01T10:00:00Z',
      duration: 30,
      host_id: 'host-123',
      recording_files: [{ id: 'f1', file_type: 'TRANSCRIPT', download_url: 'https://zoom.us/rec/f1' }],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockData,
    });

    const result = await getRecordings('valid_token', 'mtg-uuid');
    expect(result).toEqual({ success: true, data: mockData });
  });

  it('returns requiresReauth on 401', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await getRecordings('expired_token', 'mtg-uuid');
    expect(result).toEqual({ success: false, requiresReauth: true, error: expect.any(String) });
  });

  it('returns requiresReauth on 403', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const result = await getRecordings('bad_token', 'mtg-uuid');
    expect(result).toEqual({ success: false, requiresReauth: true, error: expect.any(String) });
  });

  it('returns error on non-auth failure with statusCode forwarded', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });

    const result = await getRecordings('token', 'mtg-uuid');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBeFalsy();
      expect(result.error).toBeTruthy();
      expect(result.statusCode).toBe(500);
    }
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await getRecordings('token', 'mtg-uuid');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Network error');
    }
  });

  it('sends token in Authorization header, not in URL', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    await getRecordings('my_secret_token', 'mtg-uuid');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).not.toContain('my_secret_token');
    expect(JSON.stringify(calledInit?.headers ?? {})).toContain('my_secret_token');
  });
});

describe('downloadTranscript', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('rejects download URLs with non-zoom.us hostname without making a fetch call', async () => {
    const result = await downloadTranscript('token', 'https://evil.com/vtt/file.vtt');
    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects URLs where the TLD is not zoom.us (e.g. evilvoom.us)', async () => {
    const result = await downloadTranscript('token', 'https://evilvoom.us/file.vtt');
    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects http:// URLs even for trusted zoom.us hostname', async () => {
    const result = await downloadTranscript('token', 'http://zoom.us/rec/file.vtt');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('HTTPS');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts zoom.us hostname', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'WEBVTT\n' });
    const result = await downloadTranscript('token', 'https://zoom.us/rec/file.vtt');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('WEBVTT\n');
  });

  it('accepts *.zoom.us subdomains', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'WEBVTT\n' });
    const result = await downloadTranscript('token', 'https://us02web.zoom.us/rec/file.vtt');
    expect(result.success).toBe(true);
  });

  it('sends token as Authorization Bearer, not as a URL query param', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'WEBVTT\n' });
    await downloadTranscript('secret_dl_token', 'https://zoom.us/rec/file.vtt');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).not.toContain('secret_dl_token');
    expect(calledUrl).not.toContain('access_token=');
    expect(JSON.stringify(calledInit?.headers ?? {})).toContain('secret_dl_token');
  });

  it('returns error when download fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await downloadTranscript('token', 'https://zoom.us/rec/missing.vtt');
    expect(result.success).toBe(false);
  });

  it('returns error without throwing when fetch throws a network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await downloadTranscript('token', 'https://zoom.us/rec/file.vtt');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('ECONNRESET');
    }
  });
});

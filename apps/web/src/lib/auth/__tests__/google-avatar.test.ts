import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pagespace/lib/services/validated-service-token', () => ({
    createUserServiceToken: vi.fn().mockResolvedValue({ token: 'service-token' }),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    auth: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import { createUserServiceToken } from '@pagespace/lib/services/validated-service-token';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isExternalHttpUrl, resolveGoogleAvatarImage } from '@/lib/auth/google-avatar';

describe('google-avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isExternalHttpUrl only accepts http(s) URLs', () => {
    expect(isExternalHttpUrl('https://lh3.googleusercontent.com/a/test=s96-c')).toBe(true);
    expect(isExternalHttpUrl('http://example.com/avatar.png')).toBe(true);
    expect(isExternalHttpUrl('/api/avatar/user/avatar.jpg?t=1')).toBe(false);
    expect(isExternalHttpUrl('data:image/png;base64,abc')).toBe(false);
    expect(isExternalHttpUrl(null)).toBe(false);
  });

  it('preserves existing same-origin avatar and skips remote fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveGoogleAvatarImage({
      userId: 'user-123',
      pictureUrl: 'https://lh3.googleusercontent.com/a/test=s96-c',
      existingImage: '/api/avatar/user-123/avatar.jpg?t=1',
    });

    expect(result).toBe('/api/avatar/user-123/avatar.jpg?t=1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-allowlisted avatar hosts', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveGoogleAvatarImage({
      userId: 'user-123',
      pictureUrl: 'https://example.com/avatar.png',
      existingImage: null,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads and stores an allowlisted Google avatar', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47,
      0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(pngBytes, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(pngBytes.byteLength),
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            filename: 'avatar.png',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveGoogleAvatarImage({
      userId: 'user-123',
      pictureUrl: 'https://lh3.googleusercontent.com/a/test=s96-c',
      existingImage: null,
    });

    expect(result).toMatch(/^\/api\/avatar\/user-123\/avatar\.png\?t=\d+$/);
    expect(createUserServiceToken).toHaveBeenCalledWith('user-123', ['avatars:write'], '5m');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when processor upload times out', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47,
      0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]);

    const abortError = new Error('upload timeout');
    abortError.name = 'AbortError';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(pngBytes, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(pngBytes.byteLength),
          },
        }),
      )
      .mockRejectedValueOnce(abortError);
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveGoogleAvatarImage({
      userId: 'user-123',
      pictureUrl: 'https://lh3.googleusercontent.com/a/test=s96-c',
      existingImage: null,
    });

    expect(result).toBeNull();
    expect(loggers.auth.warn).toHaveBeenCalledWith(
      'Processor avatar upload timed out',
      expect.objectContaining({ userId: 'user-123' })
    );
  });

  it('returns null for suspicious processor filename', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47,
      0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(pngBytes, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(pngBytes.byteLength),
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            filename: '../avatar.png',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveGoogleAvatarImage({
      userId: 'user-123',
      pictureUrl: 'https://lh3.googleusercontent.com/a/test=s96-c',
      existingImage: null,
    });

    expect(result).toBeNull();
    expect(loggers.auth.warn).toHaveBeenCalledWith(
      'Processor returned suspicious avatar filename',
      expect.objectContaining({ userId: 'user-123' })
    );
  });
});

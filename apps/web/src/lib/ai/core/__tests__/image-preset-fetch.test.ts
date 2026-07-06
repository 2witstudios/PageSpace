import { describe, it, expect } from 'vitest';
import { fetchCachedImagePreset } from '../image-preset-fetch';

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GARBAGE_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03]);

describe('fetchCachedImagePreset', () => {
  it('given a cached ai-vision preset with valid jpeg bytes, should return validated base64 for the ai-vision preset', async () => {
    const fetchBytes = async (_contentHash: string, preset: string): Promise<Buffer | null> => {
      if (preset === 'ai-vision') return JPEG_BYTES;
      if (preset === 'ai-chat') return JPEG_BYTES;
      return null;
    };

    const result = await fetchCachedImagePreset('hash-1', 'image/png', { fetchBytes });

    expect(result).toEqual({
      base64: JPEG_BYTES.toString('base64'),
      mediaType: 'image/jpeg',
      preset: 'ai-vision',
    });
  });

  it('given no cached ai-vision preset but a valid ai-chat preset, should fall back to the ai-chat preset', async () => {
    const fetchBytes = async (_contentHash: string, preset: string): Promise<Buffer | null> => {
      if (preset === 'ai-vision') return null;
      if (preset === 'ai-chat') return JPEG_BYTES;
      return null;
    };

    const result = await fetchCachedImagePreset('hash-2', 'image/png', { fetchBytes });

    expect(result).toEqual({
      base64: JPEG_BYTES.toString('base64'),
      mediaType: 'image/jpeg',
      preset: 'ai-chat',
    });
  });

  it('given neither cached preset exists, should fall back to the original file validated against the page mimeType', async () => {
    const fetchBytes = async (_contentHash: string, preset: string): Promise<Buffer | null> => {
      if (preset === 'original') return PNG_BYTES;
      return null;
    };

    const result = await fetchCachedImagePreset('hash-3', 'image/png', { fetchBytes });

    expect(result).toEqual({
      base64: PNG_BYTES.toString('base64'),
      mediaType: 'image/png',
      preset: 'original',
    });
  });

  it('given a cached preset whose bytes fail magic-byte validation, should skip it and fall through to the next preset in the chain', async () => {
    const fetchBytes = async (_contentHash: string, preset: string): Promise<Buffer | null> => {
      if (preset === 'ai-vision') return GARBAGE_BYTES;
      if (preset === 'ai-chat') return JPEG_BYTES;
      return null;
    };

    const result = await fetchCachedImagePreset('hash-4', 'image/png', { fetchBytes });

    expect(result).toEqual({
      base64: JPEG_BYTES.toString('base64'),
      mediaType: 'image/jpeg',
      preset: 'ai-chat',
    });
  });

  it('given every preset in the chain is missing or invalid, should return null', async () => {
    const fetchBytes = async (): Promise<Buffer | null> => null;

    const result = await fetchCachedImagePreset('hash-5', 'image/png', { fetchBytes });

    expect(result).toBeNull();
  });

  it('given an oversized original fallback with no smaller preset available, should skip it and return null rather than deliver an unbounded payload', async () => {
    const OVERSIZED_PNG = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    const fetchBytes = async (_contentHash: string, preset: string): Promise<Buffer | null> => {
      if (preset === 'original') return OVERSIZED_PNG;
      return null;
    };

    const result = await fetchCachedImagePreset('hash-6', 'image/png', { fetchBytes });

    expect(result).toBeNull();
  });

  it('given a non-404 error on one candidate, should treat it as unusable and fall through to the next preset rather than throwing', async () => {
    const fetchBytes = async (_contentHash: string, preset: string): Promise<Buffer | null> => {
      if (preset === 'ai-vision') throw Object.assign(new Error('Access Denied'), { $metadata: { httpStatusCode: 403 } });
      if (preset === 'ai-chat') return JPEG_BYTES;
      return null;
    };

    const result = await fetchCachedImagePreset('hash-7', 'image/png', { fetchBytes });

    expect(result).toEqual({
      base64: JPEG_BYTES.toString('base64'),
      mediaType: 'image/jpeg',
      preset: 'ai-chat',
    });
  });

  it('given every candidate throws a non-404 error, should return null rather than throwing', async () => {
    const fetchBytes = async (): Promise<Buffer | null> => {
      throw new Error('S3 unavailable');
    };

    const result = await fetchCachedImagePreset('hash-8', 'image/png', { fetchBytes });

    expect(result).toBeNull();
  });
});

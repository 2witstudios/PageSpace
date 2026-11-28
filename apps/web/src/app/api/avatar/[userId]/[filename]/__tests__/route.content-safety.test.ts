import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const send = vi.fn();
vi.mock('@/lib/presigned-url', () => ({ getS3Bucket: () => 'uploads', getS3Client: () => ({ send: (...args: unknown[]) => send(...args) }) }));
const isHashBlocked = vi.fn();
vi.mock('@pagespace/lib/content-safety/blocklist', () => ({ isHashBlocked: (...args: unknown[]) => isHashBlocked(...args) }));

import { GET } from '../route';

const USER = 'clh3am7ho0000ml08f8gth9r0';
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const get = () => GET(new NextRequest(`http://localhost:3000/api/avatar/${USER}/avatar.png`), { params: Promise.resolve({ userId: USER, filename: 'avatar.png' }) });

describe('GET /api/avatar/:userId/:filename — content safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    send.mockResolvedValue({ Body: { transformToByteArray: async () => BYTES } });
    isHashBlocked.mockResolvedValue(false);
  });

  it('serves an avatar whose bytes are not blocked, cached for a bounded time only', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(isHashBlocked).toHaveBeenCalledWith(createHash('sha256').update(BYTES).digest('hex'));
    // Not a year and not immutable: a cached copy of an avatar blocked later stops being served within the hour.
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('never serves blocked bytes (an avatar stored as its hash was being blocked), and that answer is not cached', async () => {
    isHashBlocked.mockResolvedValue(true);
    const response = await get();
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('serves nothing when the blocklist cannot be read', async () => {
    isHashBlocked.mockRejectedValue(new Error('db down'));
    const response = await get();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

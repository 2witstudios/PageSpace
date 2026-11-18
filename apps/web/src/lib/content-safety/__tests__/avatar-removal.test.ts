import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { hideScannedAvatar, removeScannedAvatar, type AvatarRemovalStore } from '../avatar-removal';

const SCANNED = new Uint8Array([1, 2, 3]);
const REPLACEMENT = new Uint8Array([9, 9, 9]);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const target = { userId: 'user-1', key: 'avatars/user-1/avatar.png', contentHash: hash(SCANNED) };

/**
 * An in-memory user row and avatar object, with the same conditional semantics as Postgres (`where image = $1`)
 * and S3 (`DeleteObject If-Match`). `between` runs a concurrent upload at a chosen point of the removal.
 */
function world(options: { between?: 'read_image' | 'read_object' | 'clear'; etag?: boolean; image?: string } = {}) {
  const etags = options.etag === false ? [null, null] : ['"a"', '"b"'];
  const state = {
    image: (options.image ?? '/api/avatar/user-1/avatar.png?t=1') as string | null,
    object: { bytes: SCANNED, etag: etags[0] } as { bytes: Uint8Array; etag: string | null } | null,
  };
  const upload = () => {
    // The processor stores the new avatar at the same key, then the account route points the profile at it.
    state.object = { bytes: REPLACEMENT, etag: etags[1] };
    state.image = '/api/avatar/user-1/avatar.png?t=2';
  };
  const store: AvatarRemovalStore = {
    readProfileImage: vi.fn(async () => {
      const image = state.image;
      if (options.between === 'read_image') upload();
      return image;
    }),
    readObject: vi.fn(async () => {
      const object = state.object;
      // Only the first read (the check) is followed by the upload; the re-read before the delete sees the result.
      if (options.between === 'read_object' && vi.mocked(store.readObject).mock.calls.length === 1) upload();
      return object;
    }),
    clearProfileImageIf: vi.fn(async (_userId: string, expected: string) => {
      const cleared = state.image === expected;
      if (cleared) state.image = null;
      if (options.between === 'clear') upload();
      return cleared;
    }),
    deleteObjectIf: vi.fn(async (_key: string, etag: string | null) => {
      if (!state.object) return 'gone' as const;
      if (etag !== null && state.object.etag !== etag) return 'changed' as const;
      state.object = null;
      return 'deleted' as const;
    }),
  };
  return { state, store };
}

describe('removeScannedAvatar', () => {
  it('removes the scanned avatar: profile cleared, then exactly that object deleted', async () => {
    const { state, store } = world();
    await expect(removeScannedAvatar(target, store)).resolves.toBe('removed');
    expect(state).toEqual({ image: null, object: null });
  });

  it('an avatar replaced before it is checked is left alone', async () => {
    const { state, store } = world({ between: 'read_image' });
    await expect(removeScannedAvatar(target, store)).resolves.toBe('replaced');
    expect(state.object?.bytes).toEqual(REPLACEMENT);
    expect(state.image).toContain('t=2');
  });

  it('a replacement stored after the check keeps its object and its profile image', async () => {
    const { state, store } = world({ between: 'read_object' });
    await expect(removeScannedAvatar(target, store)).resolves.toBe('replaced');
    expect(state.object?.bytes).toEqual(REPLACEMENT);
    expect(state.image).toContain('t=2');
  });

  it('a replacement stored after the profile was cleared keeps its object (the delete is tied to the scanned one)', async () => {
    const { state, store } = world({ between: 'clear' });
    await expect(removeScannedAvatar(target, store)).resolves.toBe('replaced');
    expect(state.object?.bytes).toEqual(REPLACEMENT);
    expect(state.image).toContain('t=2');
  });

  it('on storage with no ETag, a replacement stored after the profile was cleared is still kept', async () => {
    const { state, store } = world({ between: 'clear', etag: false });
    await expect(removeScannedAvatar(target, store)).resolves.toBe('replaced');
    expect(state.object?.bytes).toEqual(REPLACEMENT);
  });

  it('a profile image pointing at another file is left alone; the scanned leftover object is still deleted', async () => {
    // A stale avatar.png left by a best-effort cleanup while the profile shows the current avatar.jpg.
    const { state, store } = world({ image: '/api/avatar/user-1/avatar.jpg?t=5' });
    await expect(removeScannedAvatar(target, store)).resolves.toBe('removed');
    expect(state.image).toBe('/api/avatar/user-1/avatar.jpg?t=5');
    expect(state.object).toBeNull();
    expect(store.clearProfileImageIf).not.toHaveBeenCalled();
  });

  it('a delete that fails throws after the profile was cleared, so the stored avatar is found and retried', async () => {
    const { state, store } = world();
    vi.mocked(store.deleteObjectIf).mockRejectedValueOnce(new Error('s3 down'));
    await expect(removeScannedAvatar(target, store)).rejects.toThrow('s3 down');
    expect(state.image).toBeNull();
    expect(state.object).not.toBeNull();
  });
});

describe('hideScannedAvatar', () => {
  it('clears the profile image of the scanned avatar and keeps its object', async () => {
    const { state, store } = world();
    await expect(hideScannedAvatar(target, store)).resolves.toBe('hidden');
    expect(state.image).toBeNull();
    expect(state.object?.bytes).toEqual(SCANNED);
  });

  it('never clears a profile image that points at another file', async () => {
    const { state, store } = world({ image: 'https://lh3.googleusercontent.com/a/photo' });
    await expect(hideScannedAvatar(target, store)).resolves.toBe('replaced');
    expect(state.image).toBe('https://lh3.googleusercontent.com/a/photo');
  });

  it('never clears a replacement\'s profile image', async () => {
    for (const between of ['read_image', 'read_object'] as const) {
      const { state, store } = world({ between });
      await expect(hideScannedAvatar(target, store)).resolves.toBe('replaced');
      expect(state.image).toContain('t=2');
    }
  });
});

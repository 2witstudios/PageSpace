import { describe, it, expect } from 'vitest';
import {
  AVATAR_ACCEPT,
  avatarFilenameFromPath,
  avatarPath,
  avatarStorageKey,
  isAvatarPath,
  isMarkColor,
  MARK_COLORS,
  markColorName,
} from '../avatar-core';

describe('drive avatar paths (the shared avatar rules, for the drive subject)', () => {
  it('a drive avatar is stored in its own drive folder and served from its drive-scoped PageSpace path', () => {
    expect(avatarStorageKey('drive', 'drv_1', 'avatar-k3x9.png')).toBe('drive-avatars/drv_1/avatar-k3x9.png');
    expect(avatarPath('drive', 'drv_1', 'avatar-k3x9.png')).toBe('/api/drives/drv_1/avatar/avatar-k3x9.png');
    expect(isAvatarPath('drive', 'drv_1', '/api/drives/drv_1/avatar/avatar-k3x9.webp')).toBe(true);
    expect(avatarFilenameFromPath('drive', 'drv_1', '/api/drives/drv_1/avatar/avatar-k3x9.png')).toBe('avatar-k3x9.png');
  });

  it('an outside URL, another drive\'s path, an org path, a traversal or an unknown type is refused', () => {
    for (const value of [
      'https://tracker.example.com/pixel.png',
      '//tracker.example.com/pixel.png',
      'data:image/png;base64,AAAA',
      '/api/drives/drv_other/avatar/avatar-k3x9.png',
      '/api/orgs/drv_1/avatar/avatar-k3x9.png',
      '/api/drives/drv_1/avatar/../../avatar/u1/avatar-k3x9.png',
      '/api/drives/drv_1/avatar/avatar-k3x9.svg',
      '/api/drives/drv_1/avatar/avatar-k3x9.png?x=https://evil',
    ]) {
      expect(isAvatarPath('drive', 'drv_1', value)).toBe(false);
      expect(avatarFilenameFromPath('drive', 'drv_1', value)).toBeNull();
    }
  });

  it('the org and drive subjects never share a folder or a route', () => {
    expect(avatarStorageKey('org', 'x', 'avatar-a.png')).not.toBe(avatarStorageKey('drive', 'x', 'avatar-a.png'));
    expect(isAvatarPath('org', 'x', avatarPath('drive', 'x', 'avatar-a.png'))).toBe(false);
  });
});

describe('mark colors', () => {
  it('accepts only a palette key', () => {
    for (const color of MARK_COLORS) expect(isMarkColor(color)).toBe(true);
    for (const value of ['#ff0000', 'Teal', '', null, 3, 'red; background:url(x)']) expect(isMarkColor(value)).toBe(false);
  });

  it('names a key as people read it', () => {
    expect(markColorName('teal')).toBe('Teal');
  });
});

describe('the file picker accept list', () => {
  it('lists each accepted type once, without the image/jpg alias', () => {
    expect(AVATAR_ACCEPT).toBe('image/png,image/jpeg,image/gif,image/webp');
  });
});

import { describe, it, expect } from 'vitest';
import { isOrgAvatarPath, orgAvatarFilename, orgAvatarPath } from '../org-avatar-core';

describe('org avatar paths (ORG-1: the avatar is a file PageSpace stores and serves, never an outside URL)', () => {
  it('ORG-1 (partial) the stored avatar is the org-scoped PageSpace path of the uploaded file, versioned for cache busting', () => {
    expect(orgAvatarPath('org_nw1', 'avatar.png', 1760000000000)).toBe('/api/orgs/org_nw1/avatar/avatar.png?v=1760000000000');
    expect(isOrgAvatarPath('org_nw1', '/api/orgs/org_nw1/avatar/avatar.webp?v=1')).toBe(true);
  });

  it('ORG-1 (partial) any outside URL, another org\'s path, a traversal or an unknown file type is refused', () => {
    for (const value of [
      'https://tracker.example.com/pixel.png',
      '//tracker.example.com/pixel.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '/api/orgs/org_other/avatar/avatar.png?v=1',
      '/api/orgs/org_nw1/avatar/../../avatar/u1/avatar.png?v=1',
      '/api/orgs/org_nw1/avatar/avatar.svg?v=1',
      '/api/orgs/org_nw1/avatar/avatar.png',
      '/api/orgs/org_nw1/avatar/avatar.png?v=1&x=https://evil',
    ]) {
      expect(isOrgAvatarPath('org_nw1', value)).toBe(false);
    }
  });

  it('ORG-1 (partial) the stored filename comes from the image type, never from the uploader', () => {
    expect(orgAvatarFilename('image/png')).toBe('avatar.png');
    expect(orgAvatarFilename('image/jpeg')).toBe('avatar.jpg');
    expect(orgAvatarFilename('image/webp')).toBe('avatar.webp');
    expect(orgAvatarFilename('image/gif')).toBe('avatar.gif');
    expect(orgAvatarFilename('image/svg+xml')).toBeNull();
    expect(orgAvatarFilename('text/html')).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { isOrgAvatarPath, orgAvatarFilename, orgAvatarFilenameFromPath, orgAvatarPath } from '../org-avatar-core';

describe('org avatar paths (the avatar is a file PageSpace stores and serves, never an outside URL)', () => {
  it('ORG-1 (partial) every upload is its own file (named from its type and a fresh nonce), and the stored avatar is its org-scoped PageSpace path', () => {
    expect(orgAvatarFilename('image/png', 'k3x9')).toBe('avatar-k3x9.png');
    expect(orgAvatarPath('org_nw1', 'avatar-k3x9.png')).toBe('/api/orgs/org_nw1/avatar/avatar-k3x9.png');
    expect(isOrgAvatarPath('org_nw1', '/api/orgs/org_nw1/avatar/avatar-k3x9.webp')).toBe(true);
    expect(orgAvatarFilenameFromPath('org_nw1', '/api/orgs/org_nw1/avatar/avatar-k3x9.png')).toBe('avatar-k3x9.png');
  });

  it('ORG-1 (partial) any outside URL, another org\'s path, a traversal or an unknown file type is refused', () => {
    for (const value of [
      'https://tracker.example.com/pixel.png',
      '//tracker.example.com/pixel.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '/api/orgs/org_other/avatar/avatar-k3x9.png',
      '/api/orgs/org_nw1/avatar/../../avatar/u1/avatar-k3x9.png',
      '/api/orgs/org_nw1/avatar/avatar-k3x9.svg',
      '/api/orgs/org_nw1/avatar/avatar.png',
      '/api/orgs/org_nw1/avatar/avatar-K3X9.png',
      '/api/orgs/org_nw1/avatar/avatar-k3x9.png?x=https://evil',
    ]) {
      expect(isOrgAvatarPath('org_nw1', value)).toBe(false);
      expect(orgAvatarFilenameFromPath('org_nw1', value)).toBeNull();
    }
  });

  it('ORG-1 (partial) the stored filename comes from the image type and the nonce, never from the uploader', () => {
    expect(orgAvatarFilename('image/jpeg', 'a1')).toBe('avatar-a1.jpg');
    expect(orgAvatarFilename('image/webp', 'a1')).toBe('avatar-a1.webp');
    expect(orgAvatarFilename('image/gif', 'a1')).toBe('avatar-a1.gif');
    expect(orgAvatarFilename('image/svg+xml', 'a1')).toBeNull();
    expect(orgAvatarFilename('text/html', 'a1')).toBeNull();
    expect(orgAvatarFilename('image/png', '../x')).toBeNull();
  });
});

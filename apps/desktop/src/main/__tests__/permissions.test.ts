import { describe, it, expect } from 'vitest';
import {
  isMediaPermission,
  isTrustedMediaOrigin,
  shouldAllowMediaPermission,
} from '../permissions';

describe('desktop media permissions', () => {
  const appUrl = 'https://pagespace.ai/dashboard';

  it('allows microphone-related permissions for trusted origin', () => {
    expect(shouldAllowMediaPermission('audioCapture', 'https://pagespace.ai/dashboard', appUrl)).toBe(true);
    expect(shouldAllowMediaPermission('media', 'https://pagespace.ai/chat', appUrl)).toBe(true);
  });

  it('denies media permissions for untrusted origin', () => {
    expect(shouldAllowMediaPermission('audioCapture', 'https://evil.example/voice', appUrl)).toBe(false);
    expect(shouldAllowMediaPermission('media', 'https://evil.example/voice', appUrl)).toBe(false);
    expect(shouldAllowMediaPermission('videoCapture', 'https://evil.example/voice', appUrl)).toBe(false);
  });

  it('denies irrelevant permissions', () => {
    expect(shouldAllowMediaPermission('notifications', 'https://pagespace.ai', appUrl)).toBe(false);
    expect(shouldAllowMediaPermission('clipboard-read', 'https://pagespace.ai', appUrl)).toBe(false);
  });

  it('recognizes only media permission classes', () => {
    expect(isMediaPermission('media')).toBe(true);
    expect(isMediaPermission('audioCapture')).toBe(true);
    expect(isMediaPermission('videoCapture')).toBe(true);
    expect(isMediaPermission('fullscreen')).toBe(false);
  });

  it('validates origin matching against configured app URL', () => {
    expect(isTrustedMediaOrigin('https://pagespace.ai/path', appUrl)).toBe(true);
    expect(isTrustedMediaOrigin('https://app.pagespace.ai/path', appUrl)).toBe(false);
    expect(isTrustedMediaOrigin('not-a-url', appUrl)).toBe(false);
  });
});

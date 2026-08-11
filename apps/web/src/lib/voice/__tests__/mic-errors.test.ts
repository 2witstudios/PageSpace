import { describe, expect, it } from 'vitest';
import {
  classifyMicFailure,
  getMicPermissionErrorMessage,
  micFailureMessage,
  type MicFailure,
} from '../mic-errors';

const named = (name: string): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};

describe('classifyMicFailure', () => {
  it('given a refused prompt, should classify it as denied', () => {
    expect(classifyMicFailure(named('NotAllowedError'))).toBe('denied');
    expect(classifyMicFailure(named('PermissionDeniedError'))).toBe('denied');
  });

  it('given no capture device, should classify it as missing', () => {
    expect(classifyMicFailure(named('NotFoundError'))).toBe('missing');
    expect(classifyMicFailure(named('DevicesNotFoundError'))).toBe('missing');
  });

  it('given a device another app holds, should classify it as busy', () => {
    expect(classifyMicFailure(named('NotReadableError'))).toBe('busy');
    expect(classifyMicFailure(named('TrackStartError'))).toBe('busy');
  });

  it('given a browser with no getUserMedia, should classify it as unsupported', () => {
    expect(classifyMicFailure(new TypeError('mediaDevices is undefined'))).toBe(
      'unsupported',
    );
  });

  it('given something unrecognised, should classify it as unknown', () => {
    expect(classifyMicFailure(named('SomeNewError'))).toBe('unknown');
    expect(classifyMicFailure('not an error at all')).toBe('unknown');
    expect(classifyMicFailure(undefined)).toBe('unknown');
    expect(classifyMicFailure(null)).toBe('unknown');
  });

  it('given a real DOMException, should classify it by name like any other error', () => {
    expect(
      classifyMicFailure(new DOMException('denied', 'NotAllowedError')),
    ).toBe('denied');
  });
});

describe('micFailureMessage', () => {
  const ALL: MicFailure[] = [
    'denied',
    'missing',
    'busy',
    'unsupported',
    'unknown',
  ];

  it('given each distinct failure, should give a distinct message', () => {
    const messages = ALL.map((failure) => micFailureMessage(failure, false));
    expect(new Set(messages).size).toBe(ALL.length);
  });

  it('given a denied prompt, should point at the OS on desktop and the browser on web', () => {
    const desktop = micFailureMessage('denied', true);
    const web = micFailureMessage('denied', false);

    expect(desktop).toContain('System Settings');
    expect(desktop).not.toContain('browser settings');
    expect(web).toContain('browser settings');
    expect(web).not.toContain('System Settings');
  });

  it('given a missing device, should say the same thing in both shells', () => {
    // Plugging in a microphone is not a per-shell instruction.
    expect(micFailureMessage('missing', true)).toBe(
      micFailureMessage('missing', false),
    );
  });
});

describe('getMicPermissionErrorMessage', () => {
  it('given denied vs missing, should surface different advice', () => {
    const denied = getMicPermissionErrorMessage(named('NotAllowedError'), false);
    const missing = getMicPermissionErrorMessage(named('NotFoundError'), false);

    expect(denied).not.toBe(missing);
    expect(denied).toContain('blocked');
    expect(missing).toContain('No microphone was detected');
  });

  it('given the desktop shell, should route a denial to System Settings', () => {
    expect(
      getMicPermissionErrorMessage(named('NotAllowedError'), true),
    ).toContain('System Settings');
  });

  it('given no explicit shell, should detect it from the window itself', () => {
    // The default argument is what every real call site uses; if it stopped
    // consulting the shell, desktop users would be sent to a settings screen
    // their app does not have.
    const electron = window.electron;
    try {
      expect(getMicPermissionErrorMessage(named('NotAllowedError'))).toContain(
        'browser settings',
      );

      (window as { electron?: unknown }).electron = { isDesktop: true };
      expect(getMicPermissionErrorMessage(named('NotAllowedError'))).toContain(
        'System Settings',
      );
    } finally {
      (window as { electron?: unknown }).electron = electron;
    }
  });
});

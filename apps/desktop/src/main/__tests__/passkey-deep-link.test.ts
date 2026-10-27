import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePasskeyRegistered } from '../passkey-deep-link';

describe('handlePasskeyRegistered', () => {
  let focusWindow: ReturnType<typeof vi.fn>;
  let sendToRenderer: ReturnType<typeof vi.fn>;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    focusWindow = vi.fn();
    sendToRenderer = vi.fn();
    logger = { info: vi.fn(), warn: vi.fn() };
  });

  it('given pagespace://passkey-registered, should focus window and broadcast IPC event', () => {
    const handled = handlePasskeyRegistered('pagespace://passkey-registered', {
      focusWindow,
      sendToRenderer,
      logger,
    });

    expect(handled).toBe(true);
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(sendToRenderer).toHaveBeenCalledTimes(1);
    expect(sendToRenderer).toHaveBeenCalledWith('passkey:registered');
  });

  it('given a URL with a different host, should return false and not touch the window', () => {
    const handled = handlePasskeyRegistered('pagespace://auth-exchange?code=abc', {
      focusWindow,
      sendToRenderer,
      logger,
    });

    expect(handled).toBe(false);
    expect(focusWindow).not.toHaveBeenCalled();
    expect(sendToRenderer).not.toHaveBeenCalled();
  });

  it('given an unparsable URL, should return false and log a warning', () => {
    const handled = handlePasskeyRegistered('not a url', {
      focusWindow,
      sendToRenderer,
      logger,
    });

    expect(handled).toBe(false);
    expect(focusWindow).not.toHaveBeenCalled();
    expect(sendToRenderer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

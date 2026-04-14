import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<Handler>>();
  const exposed: Record<string, unknown> = {};

  const ipcRenderer = {
    on: vi.fn((channel: string, handler: Handler) => {
      const set = listeners.get(channel) ?? new Set<Handler>();
      set.add(handler);
      listeners.set(channel, set);
    }),
    removeListener: vi.fn((channel: string, handler: Handler) => {
      listeners.get(channel)?.delete(handler);
    }),
    removeAllListeners: vi.fn((channel: string) => {
      listeners.delete(channel);
    }),
    invoke: vi.fn(async () => undefined),
  };

  const contextBridge = {
    exposeInMainWorld: vi.fn((key: string, api: unknown) => {
      exposed[key] = api;
    }),
  };

  function emit(channel: string, ...args: unknown[]): void {
    const handlers = listeners.get(channel);
    if (!handlers) return;
    for (const h of handlers) h({}, ...args);
  }

  return { ipcRenderer, contextBridge, listeners, exposed, emit };
});

vi.mock('electron', () => ({
  ipcRenderer: mocks.ipcRenderer,
  contextBridge: mocks.contextBridge,
}));

interface ExposedElectron {
  passkey: {
    onRegistered: (callback: () => void) => () => void;
  };
}

function getExposedElectron(): ExposedElectron {
  return mocks.exposed.electron as ExposedElectron;
}

describe('preload passkey bridge', () => {
  beforeEach(async () => {
    mocks.listeners.clear();
    for (const key of Object.keys(mocks.exposed)) delete mocks.exposed[key];
    mocks.ipcRenderer.on.mockClear();
    mocks.ipcRenderer.removeListener.mockClear();
    vi.resetModules();
    await import('../index');
  });

  it('exposes window.electron.passkey.onRegistered', () => {
    const electron = getExposedElectron();
    expect(typeof electron.passkey?.onRegistered).toBe('function');
  });

  it('subscribes to passkey:registered and invokes the callback when emitted', () => {
    const electron = getExposedElectron();
    const cb = vi.fn();

    electron.passkey.onRegistered(cb);
    expect(mocks.ipcRenderer.on).toHaveBeenCalledWith('passkey:registered', expect.any(Function));

    mocks.emit('passkey:registered');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returns an unsubscribe function that removes the listener', () => {
    const electron = getExposedElectron();
    const cb = vi.fn();

    const unsubscribe = electron.passkey.onRegistered(cb);
    expect(typeof unsubscribe).toBe('function');

    unsubscribe();
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'passkey:registered',
      expect.any(Function),
    );

    mocks.emit('passkey:registered');
    expect(cb).not.toHaveBeenCalled();
  });
});

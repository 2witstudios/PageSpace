import { describe, it, expect, vi } from 'vitest';
import {
  getMachineSettings,
  updateMachineSettings,
  deleteMachine,
  type MachineSettings,
  type MachineSettingsStore,
  type MachineSpriteTeardown,
} from '../machine-settings';

const SETTINGS: MachineSettings = {
  name: 'My Machine',
  description: 'the build box',
  visibleToGlobalAssistant: true,
  allowPageAgents: false,
};

function makeStore(overrides: Partial<MachineSettingsStore> = {}): MachineSettingsStore {
  return {
    getSettings: vi.fn().mockResolvedValue(SETTINGS),
    updateSettings: vi.fn().mockResolvedValue(SETTINGS),
    trashPage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSprite(overrides: Partial<MachineSpriteTeardown> = {}): MachineSpriteTeardown {
  return { teardown: vi.fn().mockResolvedValue(undefined), ...overrides };
}

describe('getMachineSettings', () => {
  it('returns the store settings', async () => {
    const store = makeStore();
    await expect(getMachineSettings({ terminalId: 't1', store })).resolves.toEqual(SETTINGS);
    expect(store.getSettings).toHaveBeenCalledWith('t1');
  });

  it('returns null when the machine does not exist', async () => {
    const store = makeStore({ getSettings: vi.fn().mockResolvedValue(null) });
    await expect(getMachineSettings({ terminalId: 'gone', store })).resolves.toBeNull();
  });
});

describe('updateMachineSettings', () => {
  it('forwards the patch and returns the updated settings', async () => {
    const store = makeStore();
    const patch = { name: 'Renamed', description: null, allowPageAgents: true };
    await expect(updateMachineSettings({ terminalId: 't1', patch, store })).resolves.toEqual(SETTINGS);
    expect(store.updateSettings).toHaveBeenCalledWith('t1', patch);
  });

  it('returns null when the machine does not exist', async () => {
    const store = makeStore({ updateSettings: vi.fn().mockResolvedValue(null) });
    await expect(updateMachineSettings({ terminalId: 'gone', patch: { name: 'x' }, store })).resolves.toBeNull();
  });
});

describe('deleteMachine', () => {
  it('returns not_found without trashing or tearing down when the machine is missing', async () => {
    const store = makeStore({ getSettings: vi.fn().mockResolvedValue(null) });
    const sprite = makeSprite();
    const result = await deleteMachine({ terminalId: 'gone', store, sprite });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(store.trashPage).not.toHaveBeenCalled();
    expect(sprite.teardown).not.toHaveBeenCalled();
  });

  it('trashes the page BEFORE tearing down the Sprite', async () => {
    const calls: string[] = [];
    const store = makeStore({ trashPage: vi.fn().mockImplementation(async () => void calls.push('trash')) });
    const sprite = makeSprite({ teardown: vi.fn().mockImplementation(async () => void calls.push('teardown')) });
    const result = await deleteMachine({ terminalId: 't1', store, sprite });
    expect(result).toEqual({ ok: true, spriteTornDown: true });
    expect(calls).toEqual(['trash', 'teardown']);
  });

  it('still reports success with the page trashed when Sprite teardown fails', async () => {
    const store = makeStore();
    const sprite = makeSprite({ teardown: vi.fn().mockRejectedValue(new Error('sprite gone')) });
    const result = await deleteMachine({ terminalId: 't1', store, sprite });
    // Page trash happened; teardown failure is a recoverable orphaned-Sprite state.
    expect(store.trashPage).toHaveBeenCalledWith('t1');
    expect(result).toEqual({ ok: true, spriteTornDown: false });
  });

  it('does not swallow a page-trash failure (the non-recoverable step)', async () => {
    const store = makeStore({ trashPage: vi.fn().mockRejectedValue(new Error('db down')) });
    const sprite = makeSprite();
    await expect(deleteMachine({ terminalId: 't1', store, sprite })).rejects.toThrow('db down');
    // Sprite was never touched, so no live-page/dead-Sprite mismatch can arise.
    expect(sprite.teardown).not.toHaveBeenCalled();
  });
});

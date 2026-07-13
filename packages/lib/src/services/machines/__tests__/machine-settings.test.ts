import { describe, it, expect, vi } from 'vitest';
import {
  getMachineSettings,
  updateMachineSettings,
  deleteMachine,
  type MachineSettings,
  type MachineSettingsStore,
  type MachineSpriteTeardown,
  type MachineRefScrub,
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

function makeRefs(overrides: Partial<MachineRefScrub> = {}): MachineRefScrub {
  return { scrub: vi.fn().mockResolvedValue(undefined), ...overrides };
}

describe('getMachineSettings', () => {
  it('returns the store settings', async () => {
    const store = makeStore();
    await expect(getMachineSettings({ machineId: 't1', store })).resolves.toEqual(SETTINGS);
    expect(store.getSettings).toHaveBeenCalledWith('t1');
  });

  it('returns null when the machine does not exist', async () => {
    const store = makeStore({ getSettings: vi.fn().mockResolvedValue(null) });
    await expect(getMachineSettings({ machineId: 'gone', store })).resolves.toBeNull();
  });
});

describe('updateMachineSettings', () => {
  it('forwards the patch and returns the updated settings', async () => {
    const store = makeStore();
    const patch = { name: 'Renamed', description: null, allowPageAgents: true };
    await expect(updateMachineSettings({ machineId: 't1', patch, store })).resolves.toEqual(SETTINGS);
    expect(store.updateSettings).toHaveBeenCalledWith('t1', patch);
  });

  it('returns null when the machine does not exist', async () => {
    const store = makeStore({ updateSettings: vi.fn().mockResolvedValue(null) });
    await expect(updateMachineSettings({ machineId: 'gone', patch: { name: 'x' }, store })).resolves.toBeNull();
  });
});

describe('deleteMachine', () => {
  it('returns not_found without trashing, scrubbing, or tearing down when the machine is missing', async () => {
    const store = makeStore({ getSettings: vi.fn().mockResolvedValue(null) });
    const sprite = makeSprite();
    const refs = makeRefs();
    const result = await deleteMachine({ machineId: 'gone', store, sprite, refs });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(store.trashPage).not.toHaveBeenCalled();
    expect(refs.scrub).not.toHaveBeenCalled();
    expect(sprite.teardown).not.toHaveBeenCalled();
  });

  it('trashes the page FIRST, then scrubs agent refs, then tears down the Sprite', async () => {
    const calls: string[] = [];
    const store = makeStore({ trashPage: vi.fn().mockImplementation(async () => void calls.push('trash')) });
    const sprite = makeSprite({ teardown: vi.fn().mockImplementation(async () => void calls.push('teardown')) });
    const refs = makeRefs({ scrub: vi.fn().mockImplementation(async () => void calls.push('scrub')) });
    const result = await deleteMachine({ machineId: 't1', store, sprite, refs });
    expect(result).toEqual({ ok: true, spriteTornDown: true, agentRefsScrubbed: true });
    expect(calls).toEqual(['trash', 'scrub', 'teardown']);
    expect(refs.scrub).toHaveBeenCalledWith('t1');
  });

  it('still reports success with the page trashed when Sprite teardown fails', async () => {
    const store = makeStore();
    const sprite = makeSprite({ teardown: vi.fn().mockRejectedValue(new Error('sprite gone')) });
    const refs = makeRefs();
    const result = await deleteMachine({ machineId: 't1', store, sprite, refs });
    // Page trash happened; teardown failure is a recoverable orphaned-Sprite state.
    expect(store.trashPage).toHaveBeenCalledWith('t1');
    expect(result).toEqual({ ok: true, spriteTornDown: false, agentRefsScrubbed: true });
  });

  it('reports a ref-scrub failure without failing the delete or skipping the Sprite teardown', async () => {
    const store = makeStore();
    const sprite = makeSprite();
    const refs = makeRefs({ scrub: vi.fn().mockRejectedValue(new Error('scrub failed')) });
    const result = await deleteMachine({ machineId: 't1', store, sprite, refs });
    // The page is already trashed; a dangling ref is a degraded (reported) state,
    // and the Sprite kill must still run or we leak a live microVM.
    expect(sprite.teardown).toHaveBeenCalledWith('t1');
    expect(result).toEqual({ ok: true, spriteTornDown: true, agentRefsScrubbed: false });
  });

  it('does not swallow a page-trash failure (the non-recoverable step)', async () => {
    const store = makeStore({ trashPage: vi.fn().mockRejectedValue(new Error('db down')) });
    const sprite = makeSprite();
    const refs = makeRefs();
    await expect(deleteMachine({ machineId: 't1', store, sprite, refs })).rejects.toThrow('db down');
    // Neither post-trash step ran, so no live-page/dead-Sprite mismatch can arise.
    expect(refs.scrub).not.toHaveBeenCalled();
    expect(sprite.teardown).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable test state shared with the module mocks (hoisted above vi.mock).
const h = vi.hoisted(() => ({
  cachedMachineId: null as string | null,
  hostname: 'host-A',
  fileContents: null as string | null, // null => ENOENT
  writeShouldThrow: false,
  writes: [] as string[],
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/userData') },
}));

vi.mock('node-machine-id', () => ({
  default: {
    machineIdSync: vi.fn(() => {
      throw new Error('machine id unavailable');
    }),
  },
}));

vi.mock('node:os', () => ({
  hostname: () => h.hostname,
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => {
    if (h.fileContents === null) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return h.fileContents;
  }),
  writeFileSync: vi.fn((_path: string, data: string) => {
    if (h.writeShouldThrow) throw new Error('EROFS: read-only file system');
    h.writes.push(data);
    h.fileContents = data; // persistence succeeded
  }),
}));

vi.mock('../state', () => ({
  get cachedMachineId() { return h.cachedMachineId; },
  setCachedMachineId: (id: string | null) => { h.cachedMachineId = id; },
  get cachedSession() { return undefined; },
  setCachedSession: vi.fn(),
}));

vi.mock('../auth-storage', () => ({
  loadAuthSession: vi.fn(),
}));

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getMachineIdentifier } from '../auth-session';

const legacyId = () => `${h.hostname}-${process.platform}-${process.arch}`;

describe('getMachineIdentifier fallback (machineIdSync unavailable)', () => {
  beforeEach(() => {
    h.cachedMachineId = null;
    h.hostname = 'host-A';
    h.fileContents = null;
    h.writeShouldThrow = false;
    h.writes = [];
    vi.clearAllMocks();
  });

  it('with no persisted file, seeds from the legacy machine-derived id and persists it (P1)', () => {
    const id = getMachineIdentifier();

    expect(id).toBe(legacyId());
    expect(h.writes).toEqual([legacyId()]); // persisted for future launches
  });

  it('reuses the persisted id and does NOT re-derive it after a hostname change', () => {
    h.fileContents = 'host-A-darwin-arm64'; // seeded on a previous launch
    h.hostname = 'host-B';                  // hostname since changed (VPN/network)

    const id = getMachineIdentifier();

    expect(id).toBe('host-A-darwin-arm64'); // persisted value wins → no device_id_mismatch
    expect(h.writes).toEqual([]);           // nothing re-persisted
  });

  it('stays stable across launches even when persistence fails (P2)', () => {
    h.writeShouldThrow = true; // read-only profile / full disk

    const first = getMachineIdentifier();
    h.cachedMachineId = null; // simulate a fresh process (new launch)
    const second = getMachineIdentifier();

    expect(first).toBe(legacyId());
    expect(second).toBe(legacyId()); // deterministic seed → identical, no churn
  });
});

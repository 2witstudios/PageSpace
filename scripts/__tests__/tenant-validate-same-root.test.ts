/**
 * `isSameStorageRoot` against an alias that `realpathSync` does NOT collapse.
 *
 * A separate file because `vi.mock` is hoisted and module-scoped: pinning
 * `realpathSync` to the identity is exactly the situation being reproduced —
 * two bind mounts of one Docker volume are two real mount-point pathnames, and
 * canonicalising either one returns itself — but it would also disable the
 * two-spellings cases in `tenant-validate.test.ts`, which need the real thing.
 *
 * Why simulate at all: a bind mount needs privileges no test has, a hard link
 * to a directory is refused by every filesystem this runs on, and the one
 * genuine alias available here (a macOS firmlink, asserted in
 * `tenant-validate.test.ts`) does not exist on Linux CI. With realpath pinned,
 * `statSync` stays REAL — so this pins the (dev, ino) comparison itself on a
 * pair of paths the string compare provably cannot see through, on every
 * platform.
 *
 * No database: `validateData` is not called, and importing the module opens no
 * connections.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const identity = (target: string) => target;
  return { ...actual, realpathSync: identity, default: { ...actual, realpathSync: identity } };
});

import { isSameStorageRoot } from '../tenant-validate';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pagespace-same-root-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('isSameStorageRoot with realpath pinned to the identity', () => {
  it('still detects one directory reached by two uncollapsed pathnames', async () => {
    const root = path.join(tmpDir, 'volume');
    await mkdir(root, { recursive: true });
    // Same directory, different pathname, and with realpath pinned the two
    // strings stay different — the bind-mount shape. Built by concatenation,
    // NOT `path.join`, which would normalise the `..` away and hand the string
    // compare an easy win.
    const alias = `${root}${path.sep}..${path.sep}volume`;

    expect(alias, 'the two pathnames must actually differ').not.toBe(root);
    expect(isSameStorageRoot(root, alias)).toBe(true);
  });

  it('does not fire for two genuinely different directories', async () => {
    const a = path.join(tmpDir, 'volume-a');
    const b = path.join(tmpDir, 'volume-b');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });

    expect(isSameStorageRoot(a, b)).toBe(false);
  });

  it('still falls back to string equality when a root does not exist', () => {
    const missing = path.join(tmpDir, 'gone');
    expect(isSameStorageRoot(missing, missing)).toBe(true);
    expect(isSameStorageRoot(missing, path.join(tmpDir, 'also-gone'))).toBe(false);
  });
});

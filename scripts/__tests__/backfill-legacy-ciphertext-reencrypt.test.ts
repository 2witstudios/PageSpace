/**
 * Tests for the legacy-ciphertext re-encryption backfill runner.
 *
 * The pure planner is unit-tested in @pagespace/lib; here we verify the runner's
 * imperative loop: dry-run writes nothing, live mode rewrites only legacy-format
 * rows to the fast envelope, fast-format rows are skipped (idempotent re-runs
 * converge), per-row failures are counted without aborting the run, and
 * cursor-based pagination terminates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scryptSync, randomBytes, createCipheriv } from 'crypto';

vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', email: 'email', name: 'name' },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: () => ({}), gt: () => ({}), asc: () => ({}) }));

import { backfill, resolveReencryptMode } from '../backfill-legacy-ciphertext-reencrypt';
import { decrypt } from '@pagespace/lib/encryption/encryption-utils';

const MASTER = 'reencrypt-runner-test-master-key-32-chars-min!';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = MASTER;
});

/** Legacy 4-part `salt:iv:authTag:ciphertext` envelope, as pre-#1930 encrypt() wrote it. */
function legacyEncrypt(plaintext: string): string {
  const salt = randomBytes(32);
  const key = scryptSync(MASTER, salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [salt, iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('hex')).join(':');
}

/** Chainable select stub terminating on .limit(); returns successive batches. */
function selectReturning(batches: unknown[][]) {
  let call = 0;
  return vi.fn(() => {
    const rows = batches[call] ?? [];
    call += 1;
    const stub: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy']) stub[m] = () => stub;
    stub['limit'] = () => Promise.resolve(rows);
    return stub;
  });
}

function captureUpdate() {
  const sets: Array<Record<string, unknown>> = [];
  const update = vi.fn(() => ({
    set: (v: Record<string, unknown>) => {
      sets.push(v);
      return { where: () => Promise.resolve() };
    },
  }));
  return { update, sets };
}

describe('resolveReencryptMode (fast-format-readers safety gate)', () => {
  it('defaults to dry-run when --apply is absent', () => {
    expect(resolveReencryptMode({ apply: false, reencryptConfirmed: false })).toEqual({ ok: true, dryRun: true });
  });

  it('refuses a live --apply run unless the re-encryption is explicitly confirmed', () => {
    const mode = resolveReencryptMode({ apply: true, reencryptConfirmed: false });
    expect(mode.ok).toBe(false);
    if (!mode.ok) expect(mode.error).toContain('LEGACY_CIPHERTEXT_REENCRYPT_CONFIRMED');
  });

  it('allows a live run only when --apply AND confirmation are both present', () => {
    expect(resolveReencryptMode({ apply: true, reencryptConfirmed: true })).toEqual({ ok: true, dryRun: false });
  });
});

describe('backfill-legacy-ciphertext-reencrypt', () => {
  it('live mode: rewrites a legacy row to the fast 3-part envelope with identical plaintext', async () => {
    const select = selectReturning([[{ id: 'u1', email: legacyEncrypt('a@b.com'), name: legacyEncrypt('A') }], []]);
    const { update, sets } = captureUpdate();
    const result = await backfill(false, { select, update } as never);

    expect(result).toEqual({ legacyFound: 1, converted: 1, skipped: 0, errors: 0 });
    expect(sets).toHaveLength(1);
    expect((sets[0].email as string).split(':')).toHaveLength(3);
    expect((sets[0].name as string).split(':')).toHaveLength(3);
    expect(await decrypt(sets[0].email as string)).toBe('a@b.com');
    expect(await decrypt(sets[0].name as string)).toBe('A');
  });

  it('dry run: counts legacy rows but writes nothing', async () => {
    const select = selectReturning([[{ id: 'u1', email: legacyEncrypt('a@b.com'), name: legacyEncrypt('A') }], []]);
    const { update, sets } = captureUpdate();
    const result = await backfill(true, { select, update } as never);

    expect(result).toEqual({ legacyFound: 1, converted: 1, skipped: 0, errors: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
  });

  it('idempotent/resumable: a re-run over already-converted rows converges to zero work', async () => {
    // First pass converts the legacy row.
    const select1 = selectReturning([[{ id: 'u1', email: legacyEncrypt('a@b.com'), name: legacyEncrypt('A') }], []]);
    const cap = captureUpdate();
    await backfill(false, { select: select1, update: cap.update } as never);
    const convertedRow = { id: 'u1', email: cap.sets[0].email, name: cap.sets[0].name };

    // Second pass (e.g. resuming after an interruption) skips it.
    const { update, sets } = captureUpdate();
    const select2 = selectReturning([[convertedRow], []]);
    const result = await backfill(false, { select: select2, update } as never);

    expect(result).toEqual({ legacyFound: 0, converted: 0, skipped: 1, errors: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
  });

  it('plaintext rows are skipped — this backfill never encrypts plaintext', async () => {
    const select = selectReturning([[{ id: 'u1', email: 'plain@b.com', name: 'Plain' }], []]);
    const { update } = captureUpdate();
    const result = await backfill(false, { select, update } as never);

    expect(result).toEqual({ legacyFound: 0, converted: 0, skipped: 1, errors: 0 });
    expect(update).not.toHaveBeenCalled();
  });

  it('a row that fails to decrypt is counted as an error without aborting the run', async () => {
    const good = legacyEncrypt('ok@b.com');
    const tamperedParts = legacyEncrypt('bad@b.com').split(':');
    tamperedParts[2] = tamperedParts[2].replace(/^./, tamperedParts[2].startsWith('0') ? '1' : '0');
    const tampered = tamperedParts.join(':');

    const select = selectReturning([
      [
        { id: 'u1', email: tampered, name: legacyEncrypt('Bad') },
        { id: 'u2', email: good, name: legacyEncrypt('Ok') },
      ],
      [],
    ]);
    const { update, sets } = captureUpdate();
    const result = await backfill(false, { select, update } as never);

    expect(result).toEqual({ legacyFound: 2, converted: 1, skipped: 0, errors: 1 });
    expect(sets).toHaveLength(1);
    expect(await decrypt(sets[0].email as string)).toBe('ok@b.com');
  });

  it('paginates across batches on the ascending-id cursor and terminates', async () => {
    const select = selectReturning([
      [{ id: 'u1', email: legacyEncrypt('a@b.com'), name: legacyEncrypt('A') }],
      [{ id: 'u2', email: legacyEncrypt('b@b.com'), name: legacyEncrypt('B') }],
      [],
    ]);
    const { update, sets } = captureUpdate();
    const result = await backfill(false, { select, update } as never, 1);

    expect(result).toEqual({ legacyFound: 2, converted: 2, skipped: 0, errors: 0 });
    expect(sets).toHaveLength(2);
    // Two full batches + one short (empty) terminal batch.
    expect(select).toHaveBeenCalledTimes(3);
  });
});

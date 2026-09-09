/**
 * GA wave 2, leaf 1 — durable approvals on the machine:
 * `~/.pagespace/env-approvals.json`, keyed (envId, userId, op, subject) with a
 * chosen expiry, read through ONE descriptor with the same owner/mode checks
 * as `env-policy.json`, and treated as EMPTY on any defect — never partial.
 */
import { describe, expect, it } from 'vitest';
import { THIRTY_DAYS_MS, type DurableApproval } from '@pagespace/lib/env-bridge/decide-approval';
import type { OpenedPolicyFile } from '../policy.js';
import { APPROVALS_FILE_NAME, createApprovalsStore, defaultApprovalsPath, type ApprovalsStoreDeps } from '../approvals-store.js';

const UID = 501;
const NOW = 1_800_000_000_000;
const PATH = '/home/me/.pagespace/env-approvals.json';

const row = (over: Partial<DurableApproval> = {}): DurableApproval => ({ approvalId: 'ch_1', envId: 'env_1', userId: 'u1', op: 'exec', subject: 'exec:/usr/bin/git', scope: '30d', createdAt: NOW - 1000, expiresAt: NOW + THIRTY_DAYS_MS, ...over });
const file = (approvals: DurableApproval[]) => JSON.stringify({ version: 1, approvals });

interface Fs {
  content: string | null;
  stat: { uid: number; mode: number };
  openError?: Error;
}

function harness(fs: Fs = { content: null, stat: { uid: UID, mode: 0o100600 } }, over: Partial<ApprovalsStoreDeps> = {}) {
  const writes: string[] = [];
  const logs: string[] = [];
  const deps: ApprovalsStoreDeps = {
    path: PATH,
    uid: UID,
    open: (): OpenedPolicyFile | null => {
      if (fs.openError) throw fs.openError;
      if (fs.content === null) return null;
      return { uid: fs.stat.uid, mode: fs.stat.mode, content: fs.content };
    },
    write: async (_path, content) => {
      writes.push(content);
      fs.content = content;
    },
    now: () => NOW,
    log: (line) => void logs.push(line),
    ...over,
  };
  return { store: createApprovalsStore(deps), writes, logs, fs };
}

describe('the file: read through one descriptor, refused exactly as env-policy.json is', () => {
  it('given no file, should have no durable approvals (and say why)', () => {
    const h = harness();
    expect(h.store.entries()).toEqual([]);
    expect(h.store.reload()).toMatchObject({ reason: 'missing', approvals: [] });
  });

  it('given a valid file, should expose its rows', () => {
    const h = harness({ content: file([row()]), stat: { uid: UID, mode: 0o100600 } });
    expect(h.store.entries()).toEqual([row()]);
  });

  it('given a file writable by group or world, should ignore it (deny-all for approvals = ask) — exactly as the policy loader does', () => {
    for (const mode of [0o100660, 0o100602, 0o100666]) {
      const h = harness({ content: file([row()]), stat: { uid: UID, mode } });
      expect(h.store.entries(), mode.toString(8)).toEqual([]);
      expect(h.store.reload().reason).toBe('writable_by_others');
    }
  });

  it('given a file owned by another user, should ignore it', () => {
    const h = harness({ content: file([row()]), stat: { uid: 0, mode: 0o100600 } });
    expect(h.store.entries()).toEqual([]);
    expect(h.store.reload().reason).toBe('wrong_owner');
  });

  it('given an open that throws (not ENOENT), should fail closed as unreadable', () => {
    const h = harness({ content: 'x', stat: { uid: UID, mode: 0o100600 }, openError: new Error('EACCES') });
    expect(h.store.entries()).toEqual([]);
    expect(h.store.reload().reason).toBe('unreadable');
  });

  it('given invalid JSON, should be EMPTY', () => {
    const h = harness({ content: '{ not json', stat: { uid: UID, mode: 0o100600 } });
    expect(h.store.entries()).toEqual([]);
    expect(h.store.reload().reason).toBe('invalid_json');
  });

  it('given one bad row among good ones, should be EMPTY — never partial', () => {
    const h = harness({ content: JSON.stringify({ version: 1, approvals: [row(), { approvalId: 'bad' }] }), stat: { uid: UID, mode: 0o100600 } });
    expect(h.store.entries()).toEqual([]);
    expect(h.store.reload().reason).toBe('invalid_schema');
  });

  it('should re-read the file on every entries() call so an out-of-band edit, chmod or delete takes effect at the next decision', () => {
    const h = harness({ content: file([row()]), stat: { uid: UID, mode: 0o100600 } });
    expect(h.store.entries()).toHaveLength(1);
    h.fs.stat = { uid: UID, mode: 0o100664 };
    expect(h.store.entries()).toHaveLength(0);
    h.fs.stat = { uid: UID, mode: 0o100600 };
    h.fs.content = null;
    expect(h.store.entries()).toHaveLength(0);
  });

  it('defaultApprovalsPath: PAGESPACE_ENV_APPROVALS wins, else ~/.pagespace/env-approvals.json', () => {
    expect(APPROVALS_FILE_NAME).toBe('env-approvals.json');
    expect(defaultApprovalsPath({}, '/home/me')).toBe(PATH);
    expect(defaultApprovalsPath({ PAGESPACE_ENV_APPROVALS: '/etc/ps/a.json' }, '/home/me')).toBe('/etc/ps/a.json');
  });
});

describe('remembering an approval: once ⇒ nothing, session ⇒ this process only, 30d / until_revoked ⇒ the file', () => {
  it('given scope 30d, should write the rows to the file with expiresAt = createdAt + 30 days and expose them', async () => {
    const h = harness();
    await h.store.remember({ approvalId: 'ch_1', envId: 'env_1', userId: 'u1', op: 'exec', subjects: ['exec:/usr/bin/git', 'builtin:cd'], scope: '30d' });
    expect(h.writes).toHaveLength(1);
    const written = JSON.parse(h.writes[0]!) as { version: number; approvals: DurableApproval[] };
    expect(written.version).toBe(1);
    expect(written.approvals).toEqual([
      { approvalId: 'ch_1', envId: 'env_1', userId: 'u1', op: 'exec', subject: 'exec:/usr/bin/git', scope: '30d', createdAt: NOW, expiresAt: NOW + THIRTY_DAYS_MS },
      { approvalId: 'ch_1', envId: 'env_1', userId: 'u1', op: 'exec', subject: 'builtin:cd', scope: '30d', createdAt: NOW, expiresAt: NOW + THIRTY_DAYS_MS },
    ]);
    expect(h.store.entries()).toHaveLength(2);
    expect(h.writes[0]!.endsWith('\n')).toBe(true);
  });

  it('given scope until_revoked, should write rows with no expiry', async () => {
    const h = harness();
    await h.store.remember({ approvalId: 'ch_2', envId: 'env_1', userId: 'u1', op: 'fs_read', subjects: ['root:/home/me/proj'], scope: 'until_revoked' });
    expect(h.store.entries()).toEqual([expect.objectContaining({ approvalId: 'ch_2', scope: 'until_revoked', expiresAt: null })]);
  });

  it('given scope session, should remember in memory only — nothing written, gone with the process', async () => {
    const h = harness();
    await h.store.remember({ approvalId: 'ch_3', envId: 'env_1', userId: 'u1', op: 'exec', subjects: ['exec:/bin/ls'], scope: 'session' });
    expect(h.writes).toHaveLength(0);
    expect(h.store.entries()).toEqual([expect.objectContaining({ approvalId: 'ch_3', scope: 'session', expiresAt: null })]);
  });

  it('given scope once, should remember NOTHING', async () => {
    const h = harness();
    await h.store.remember({ approvalId: 'ch_4', envId: 'env_1', userId: 'u1', op: 'exec', subjects: ['exec:/bin/ls'], scope: 'once' });
    expect(h.writes).toHaveLength(0);
    expect(h.store.entries()).toEqual([]);
  });

  it('should MERGE with the rows already in the file (read-merge-write), never clobber them', async () => {
    const h = harness({ content: file([row()]), stat: { uid: UID, mode: 0o100600 } });
    await h.store.remember({ approvalId: 'ch_9', envId: 'env_1', userId: 'u1', op: 'exec', subjects: ['exec:/bin/rm'], scope: '30d' });
    expect(h.store.entries().map((a) => a.approvalId)).toEqual(['ch_1', 'ch_9']);
  });

  it('given the existing file is REFUSED (wrong owner / writable by others / invalid), should NOT overwrite it — the approval is kept for this process only and the refusal is logged', async () => {
    const h = harness({ content: file([row()]), stat: { uid: 0, mode: 0o100600 } });
    await h.store.remember({ approvalId: 'ch_5', envId: 'env_1', userId: 'u1', op: 'exec', subjects: ['exec:/bin/ls'], scope: '30d' });
    expect(h.writes).toHaveLength(0);
    expect(h.logs.join('\n')).toMatch(/wrong_owner/);
    // Held in memory so the owner's click still counts for the life of the daemon.
    expect(h.store.entries()).toEqual([expect.objectContaining({ approvalId: 'ch_5' })]);
  });

  it('given the write fails, should keep the approval in memory and log — never throw into the dispatcher', async () => {
    const h = harness(undefined, { write: async () => { throw new Error('EROFS'); } });
    await expect(h.store.remember({ approvalId: 'ch_6', envId: 'env_1', userId: 'u1', op: 'exec', subjects: ['exec:/bin/ls'], scope: '30d' })).resolves.toBeUndefined();
    expect(h.logs.join('\n')).toMatch(/EROFS/);
    expect(h.store.entries()).toEqual([expect.objectContaining({ approvalId: 'ch_6' })]);
  });
});

describe('revoking exactly one approval', () => {
  it('given an approvalId, should delete every row of THAT approval from the file and from memory, and nothing else', async () => {
    const h = harness({ content: file([row(), row({ subject: 'builtin:cd' }), row({ approvalId: 'ch_2', subject: 'exec:/bin/rm' })]), stat: { uid: UID, mode: 0o100600 } });
    await h.store.remember({ approvalId: 'ch_3', envId: 'env_1', userId: 'u1', op: 'exec', subjects: ['exec:/bin/ls'], scope: 'session' });
    expect(await h.store.revoke('ch_1')).toBe(2);
    expect(h.store.entries().map((a) => a.approvalId)).toEqual(['ch_2', 'ch_3']);
    expect(await h.store.revoke('ch_3')).toBe(1);
    expect(h.store.entries().map((a) => a.approvalId)).toEqual(['ch_2']);
    expect(await h.store.revoke('nope')).toBe(0);
  });

  it('prune(now) should drop expired rows from the file', async () => {
    const h = harness({ content: file([row({ expiresAt: NOW - 1 }), row({ approvalId: 'live' })]), stat: { uid: UID, mode: 0o100600 } });
    expect(await h.store.prune(NOW)).toBe(1);
    expect(h.store.entries().map((a) => a.approvalId)).toEqual(['live']);
  });
});

describe('the production writer', () => {
  it('writeApprovalsFile writes 0600 via a temp file and rename (atomic: a crash mid-write cannot leave a half file)', async () => {
    const { writeApprovalsFile } = await import('../approvals-store.js');
    const { mkdtempSync, readFileSync, statSync, readdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/ps-approvals-`);
    try {
      const path = `${dir}/nested/env-approvals.json`;
      await writeApprovalsFile(path, '{"version":1,"approvals":[]}\n');
      expect(readFileSync(path, 'utf8')).toBe('{"version":1,"approvals":[]}\n');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${dir}/nested`).mode & 0o777).toBe(0o700);
      expect(readdirSync(`${dir}/nested`)).toEqual(['env-approvals.json']);
      await writeApprovalsFile(path, '{"version":1,"approvals":[]}\n');
      expect(readdirSync(`${dir}/nested`)).toEqual(['env-approvals.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never imports anything but node:fs / node:path / lib-core (no network, no child_process)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../approvals-store.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.every((s) => s === 'node:fs' || s === 'node:fs/promises' || s === 'node:path' || s === './lib-core.js' || s === './policy.js')).toBe(true);
    expect(source).not.toMatch(/fetch\(|from 'ws'|child_process/);
  });
});


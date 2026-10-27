import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const FLYCTL = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, args.join(' ') + '\\n');
const app = args[args.indexOf('--app') + 1];
const drained = process.env.CALLS + '.' + app;
if (args[0] === 'config' && process.env.MODE === 'save-fails') process.exit(1);
if (args[0] === 'config') {
  const path = args[args.indexOf('--config') + 1];
  // flyctl resolves --config as an existing input before fetching/saving it.
  if (!fs.existsSync(path)) { console.error('config file not found at specified path'); process.exit(1); }
  fs.writeFileSync(path, '# original config');
}
if (args[0] === 'scale' && args[2].endsWith('=0')) fs.writeFileSync(drained, 'yes');
if (args[0] === 'scale' && !args[2].endsWith('=0') && fs.existsSync(drained)) fs.unlinkSync(drained);
if (args[0] === 'machines') console.log(JSON.stringify(process.env.MODE === 'empty' || (fs.existsSync(drained) && process.env.MODE !== 'remains') ? [] : [{ id: 'old', state: 'stopped', region: 'iad', config: { metadata: { fly_process_group: 'app' } } }]));
`;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-test-')); dirs.push(dir);
  writeFileSync(join(dir, 'flyctl'), FLYCTL, { mode: 0o755 });
  return dir;
}
function readCalls(dir: string): string {
  try { return readFileSync(join(dir, 'calls'), 'utf8'); } catch { return ''; }
}
function cutover(dir: string, args: string[], { mode = '', candidate = 'candidate-sha' } = {}) {
  const before = readCalls(dir).length;
  const result = spawnSync('bash', [resolve('fly-billing-cutover.sh'), ...args, join(dir, 'configs')], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MODE: mode, CALLS: join(dir, 'calls'), CUTOVER_CANDIDATE_SHA: candidate, GITHUB_SHA: '' },
    encoding: 'utf8',
  });
  return { result, calls: readCalls(dir).slice(before) };
}
describe('Fly offline cutover', () => {
  it('saves configuration before draining all five application fleets and verifies none remain', () => {
    const dir = setup();
    const { result, calls } = cutover(dir, []);
    expect(result.status, result.stderr).toBe(0);
    expect(calls.match(/config save/g)).toHaveLength(5);
    expect(calls.lastIndexOf('config save')).toBeLessThan(calls.indexOf('scale count'));
    expect(calls.slice(0, calls.indexOf('scale count')).match(/machines list/g)).toHaveLength(5);
    for (const app of ['web', 'admin', 'realtime', 'processor', 'cron']) {
      expect(calls).toContain(`scale count app=0 --app pagespace-${app} --yes`);
      expect(calls).toContain(`machines list --app pagespace-${app} --json`);
    }
  });
  it('refuses even stopped old machines because the proxy can restart them', () => {
    expect(cutover(setup(), [], { mode: 'remains' }).result.status).not.toBe(0);
  });
  it('does not drain anything if a configuration snapshot fails', () => {
    const { result, calls } = cutover(setup(), [], { mode: 'save-fails' });
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('scale count');
  });
  it('snapshot alone is non-destructive and leaves a sealed, checksummed topology', () => {
    const dir = setup();
    const { result, calls } = cutover(dir, ['snapshot']);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).not.toContain('scale count');
    expect(existsSync(join(dir, 'configs', 'COMPLETE'))).toBe(true);
    expect(readFileSync(join(dir, 'configs', 'SHA256SUMS'), 'utf8')).toContain('pagespace-cron.topology.json');
  });
  it('drain refuses to run without a sealed snapshot and never snapshots', () => {
    const dir = setup();
    const { result, calls } = cutover(dir, ['drain']);
    expect(result.status).not.toBe(0);
    expect(calls).toBe('');
  });
  it('drains from the snapshot that was taken earlier, without taking another', () => {
    const dir = setup();
    expect(cutover(dir, ['snapshot']).result.status).toBe(0);
    const { result, calls } = cutover(dir, ['drain']);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).not.toContain('config save');
    expect(calls).toContain('scale count app=0 --app pagespace-cron --yes');
  });
  it('refuses to snapshot fleets that are already empty, so a retry cannot erase the topology', () => {
    const dir = setup();
    const { result, calls } = cutover(dir, ['snapshot'], { mode: 'empty' });
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('scale count');
    expect(existsSync(join(dir, 'configs', 'COMPLETE'))).toBe(false);
  });
  it('a retry after a lost runner reuses the original sealed snapshot unchanged', () => {
    const dir = setup();
    expect(cutover(dir, []).result.status).toBe(0);
    const sealed = readFileSync(join(dir, 'configs', 'SHA256SUMS'), 'utf8');
    const retry = cutover(dir, ['drain']);
    expect(retry.result.status, retry.result.stderr).toBe(0);
    expect(retry.calls).not.toContain('config save');
    expect(readFileSync(join(dir, 'configs', 'SHA256SUMS'), 'utf8')).toBe(sealed);
  });
  it('refuses a drain from a snapshot that was altered after sealing', () => {
    const dir = setup();
    expect(cutover(dir, ['snapshot']).result.status).toBe(0);
    writeFileSync(join(dir, 'configs', 'pagespace-web.topology.json'), '[]');
    const { result, calls } = cutover(dir, ['drain']);
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('scale count');
  });
  it('refuses a drain when the snapshot was sealed for a different candidate', () => {
    const dir = setup();
    expect(cutover(dir, ['snapshot'], { candidate: 'candidate-a' }).result.status).toBe(0);
    const { result, calls } = cutover(dir, ['drain'], { candidate: 'candidate-b' });
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('scale count');
  });
  it('the workflow snapshot/drain flags verify and reuse the sealed topology', () => {
    const dir = setup();
    const snapshot = cutover(dir, ['--snapshot-only']);
    expect(snapshot.result.status, snapshot.result.stderr).toBe(0);
    expect(snapshot.calls).not.toContain('scale count');
    const drain = cutover(dir, ['--drain']);
    expect(drain.result.status, drain.result.stderr).toBe(0);
    expect(drain.calls).not.toContain('config save');
    expect(drain.calls).toContain('scale count');
  });
  it('a fresh runner restores the original counts from a copied sealed snapshot', () => {
    const original = setup();
    expect(cutover(original, ['snapshot']).result.status).toBe(0);
    const fresh = setup();
    cpSync(join(original, 'configs'), join(fresh, 'configs'), { recursive: true });
    const result = spawnSync('bash', [resolve('fly-billing-restore.sh'), join(fresh, 'configs'), 'pagespace-web'], {
      env: { ...process.env, PATH: `${fresh}:${process.env.PATH}`, CALLS: join(fresh, 'calls'), CUTOVER_CANDIDATE_SHA: 'candidate-sha' },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readCalls(fresh)).toContain('scale count app=1 --region iad --app pagespace-web --yes');
    expect(readCalls(fresh)).not.toContain('config save');
  });
  it('refuses to run without a candidate commit to bind the snapshot to', () => {
    const dir = setup();
    const { result, calls } = cutover(dir, [], { candidate: '' });
    expect(result.status).not.toBe(0);
    expect(calls).toBe('');
  });
  it('refuses to overwrite an unsealed snapshot directory', () => {
    const dir = setup();
    mkdirSync(join(dir, 'configs'), { recursive: true });
    writeFileSync(join(dir, 'configs', 'partial.toml'), 'partial');
    const { result, calls } = cutover(dir, ['snapshot']);
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('config save');
  });
});

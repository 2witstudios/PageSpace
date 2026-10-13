import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(mode = '') {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-test-')); dirs.push(dir);
  writeFileSync(join(dir, 'flyctl'), `#!/usr/bin/env node
+const fs = require('node:fs');
+const args = process.argv.slice(2);
+fs.appendFileSync(process.env.CALLS, args.join(' ') + '\\n');
+const app = args[args.indexOf('--app') + 1];
+const drained = process.env.CALLS + '.' + app;
+if (args[0] === 'config' && process.env.MODE === 'save-fails') process.exit(1);
+if (args[0] === 'scale') fs.writeFileSync(drained, 'yes');
+if (args[0] === 'machines') console.log(JSON.stringify(fs.existsSync(drained) && process.env.MODE !== 'remains' ? [] : [{ id: 'old', state: 'stopped', region: 'iad', config: { metadata: { fly_process_group: 'app' } } }]));
+`.replace(/^\+/gm, ''), { mode: 0o755 });
  const result = spawnSync('bash', [resolve('fly-billing-cutover.sh'), join(dir, 'configs')], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MODE: mode, CALLS: join(dir, 'calls') }, encoding: 'utf8' });
  let calls = ''; try { calls = readFileSync(join(dir, 'calls'), 'utf8'); } catch { /* No calls if the script refuses before invoking Fly. */ }
  return { result, calls };
}
describe('Fly offline cutover', () => {
  it('saves configuration before draining all five application fleets and verifies none remain', () => {
    const { result, calls } = run();
    expect(result.status).toBe(0);
    expect(calls.match(/config save/g)).toHaveLength(5);
    expect(calls.lastIndexOf('config save')).toBeLessThan(calls.indexOf('scale count'));
    expect(calls.slice(0, calls.indexOf('scale count')).match(/machines list/g)).toHaveLength(5);
    for (const app of ['web', 'admin', 'realtime', 'processor', 'cron']) {
      expect(calls).toContain(`scale count app=0 --app pagespace-${app} --yes`);
      expect(calls).toContain(`machines list --app pagespace-${app} --json`);
    }
  });
  it('refuses even stopped old machines because the proxy can restart them', () => {
    expect(run('remains').result.status).not.toBe(0);
  });
  it('does not drain anything if a configuration snapshot fails', () => {
    const { result, calls } = run('save-fails');
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('scale count');
  });

  // MONEY-3: snapshot and drain are separate steps so the restoration topology can be
  // persisted durably BEFORE the first destructive scale call, and a fresh resume runner
  // can drain (or restore) from the ORIGINAL snapshot instead of an empty re-snapshot.
  function runMode(mode: string) {
    const dir = mkdtempSync(join(tmpdir(), 'cutover-mode-test-')); dirs.push(dir);
    writeFileSync(join(dir, 'flyctl'), `#!/usr/bin/env node
+const fs = require('node:fs');
+const args = process.argv.slice(2);
+fs.appendFileSync(process.env.CALLS, args.join(' ') + '\\n');
+if (args[0] === 'config') process.exit(0);
+if (args[0] === 'machines') console.log(JSON.stringify([{ id: 'old', state: 'stopped', region: 'iad', config: { metadata: { fly_process_group: 'app' } } }]));
+`.replace(/^\+/gm, ''), { mode: 0o755 });
    const result = spawnSync('bash', [resolve('fly-billing-cutover.sh'), mode, join(dir, 'configs')].filter(Boolean), { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: join(dir, 'calls') }, encoding: 'utf8' });
    let calls = ''; try { calls = readFileSync(join(dir, 'calls'), 'utf8'); } catch { /* No calls if the script refuses before invoking Fly. */ }
    return { result, calls, dir };
  }
  it('--snapshot-only captures all five topologies and never scales', () => {
    const { result, calls } = runMode('--snapshot-only');
    expect(result.status).toBe(0);
    expect(calls.match(/config save/g)).toHaveLength(5);
    expect(calls).not.toContain('scale count');
  });
  it('--drain refuses without a pre-drain snapshot — an empty re-snapshot cannot restore anything', () => {
    const { result, calls } = runMode('--drain');
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('scale count');
  });
  it('--drain works from an original snapshot and never re-snapshots', () => {
    const { result, calls, dir } = runMode('--snapshot-only');
    expect(result.status).toBe(0);
    const dir2 = mkdtempSync(join(tmpdir(), 'cutover-drain-test-')); dirs.push(dir2);
    // A FRESH runner: only the durable snapshot files travel with it, no flyctl config save.
    for (const app of ['web', 'admin', 'realtime', 'processor', 'cron']) {
      for (const suffix of ['machines.json', 'topology.json']) {
        writeFileSync(join(dir2, `pagespace-${app}.${suffix}`), readFileSync(join(dir, 'configs', `pagespace-${app}.${suffix}`)));
      }
    }
    writeFileSync(join(dir2, 'flyctl'), `#!/usr/bin/env node
+const fs = require('node:fs');
+const args = process.argv.slice(2);
+fs.appendFileSync(process.env.CALLS, args.join(' ') + '\\n');
+const app = args[args.indexOf('--app') + 1];
+const drained = process.env.CALLS + '.' + app;
+if (args[0] === 'scale') fs.writeFileSync(drained, 'yes');
+if (args[0] === 'machines') console.log(JSON.stringify(fs.existsSync(drained) ? [] : [{ id: 'old', state: 'stopped', region: 'iad', config: { metadata: { fly_process_group: 'app' } } }]));
+`.replace(/^\+/gm, ''), { mode: 0o755 });
    const drainResult = spawnSync('bash', [resolve('fly-billing-cutover.sh'), '--drain', dir2], { env: { ...process.env, PATH: `${dir2}:${process.env.PATH}`, CALLS: join(dir2, 'calls') }, encoding: 'utf8' });
    expect(drainResult.status).toBe(0);
    const drainCalls = readFileSync(join(dir2, 'calls'), 'utf8');
    expect(drainCalls).toContain('scale count');
    expect(drainCalls).not.toContain('config save');
  });
});

describe('Fly restore resume (MONEY-3)', () => {
  it('refuses to restore without the original snapshot — a fresh snapshot of drained fleets would restore them as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-test-')); dirs.push(dir);
    const result = spawnSync('bash', [resolve('fly-billing-restore.sh'), dir, 'pagespace-web'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ORIGINAL topology');
  });
  it('restores the desired counts from the original snapshot and verifies the topology', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-test-')); dirs.push(dir);
    writeFileSync(join(dir, 'pagespace-web.machines.json'), JSON.stringify([
      { id: 'a', state: 'stopped', region: 'iad', config: { metadata: { fly_process_group: 'app' } } },
      { id: 'b', state: 'stopped', region: 'iad', config: { metadata: { fly_process_group: 'app' } } },
    ]));
    writeFileSync(join(dir, 'pagespace-web.toml'), '# original config');
    writeFileSync(join(dir, 'flyctl'), `#!/usr/bin/env node
+const fs = require('node:fs');
+const args = process.argv.slice(2);
+fs.appendFileSync(process.env.CALLS, args.join(' ') + '\\n');
+if (args[0] === 'machines') console.log(JSON.stringify([{ id: 'a', state: 'started', region: 'iad', config: { metadata: { fly_process_group: 'app' } } }, { id: 'b', state: 'started', region: 'iad', config: { metadata: { fly_process_group: 'app' } } }]));
+`.replace(/^\+/gm, ''), { mode: 0o755 });
    const result = spawnSync('bash', [resolve('fly-billing-restore.sh'), dir, 'pagespace-web'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: join(dir, 'calls') }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toContain('scale count app=2 --region iad --app pagespace-web --yes');
  });
});

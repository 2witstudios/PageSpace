import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(mode = '') {
  const dir = mkdtempSync(join(tmpdir(), 'restore-topology-')); dirs.push(dir);
  const machine = (region: string, group: string) => ({ region, config: { metadata: { fly_process_group: group } } });
  writeFileSync(join(dir, 'pagespace-web.machines.json'), JSON.stringify([
    machine('iad', 'web'), machine('iad', 'web'), machine('lhr', 'web'), machine('lhr', 'worker'),
  ]));
  for (const app of ['web', 'admin', 'realtime', 'processor', 'cron']) {
    writeFileSync(join(dir, `pagespace-${app}.toml`), '# original config');
    if (app !== 'web') writeFileSync(join(dir, `pagespace-${app}.machines.json`), '[]');
    writeFileSync(join(dir, `pagespace-${app}.topology.json`), '[]');
  }
  const seal = spawnSync('bash', ['-c', 'source "$1"; cutover_seal "$2" candidate-sha', 'seal', resolve('fly-cutover-lib.sh'), dir], { encoding: 'utf8' });
  expect(seal.status, seal.stderr).toBe(0);
  writeFileSync(join(dir, 'current.json'), JSON.stringify([machine('ord', 'web'), machine('ord', 'worker')]));
  writeFileSync(join(dir, 'flyctl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, args.join(' ') + '\\n');
const path = process.env.STATE;
let rows = JSON.parse(fs.readFileSync(path));
if (args[0] === 'machines') console.log(JSON.stringify(rows));
if (args[0] === 'scale' && process.env.MODE !== 'unchanged') {
  const [group, count] = args[2].split('=');
  const region = args[args.indexOf('--region') + 1];
  rows = rows.filter(row => row.region !== region || row.config.metadata.fly_process_group !== group);
  for (let i = 0; i < Number(count); i++) rows.push({ region, config: { metadata: { fly_process_group: group } } });
  fs.writeFileSync(path, JSON.stringify(rows));
}
`, { mode: 0o755 });
  const result = spawnSync('bash', [resolve('fly-billing-restore.sh'), dir, 'pagespace-web'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: join(dir, 'calls'), STATE: join(dir, 'current.json'), MODE: mode, CUTOVER_CANDIDATE_SHA: 'candidate-sha' }, encoding: 'utf8',
  });
  let calls = ''; try { calls = readFileSync(join(dir, 'calls'), 'utf8'); } catch { /* Refused before invoking Fly. */ }
  return { result, calls };
}
describe('Fly cutover topology restoration', () => {
  it('restores each process/region count and removes deploy-seeded surplus regions', () => {
    const { result, calls } = run();
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('scale count web=2 --region iad --app pagespace-web --yes');
    expect(calls).toContain('scale count web=1 --region lhr --app pagespace-web --yes');
    expect(calls).toContain('scale count worker=1 --region lhr --app pagespace-web --yes');
    expect(calls).toContain('scale count web=0 --region ord --app pagespace-web --yes');
    expect(calls).toContain('scale count worker=0 --region ord --app pagespace-web --yes');
    expect(calls.indexOf('web=2')).toBeLessThan(calls.indexOf('web=0'));
  });
  it('fails the deployment if Fly does not restore the recorded topology', () => {
    expect(run('unchanged').result.status).not.toBe(0);
  });
});

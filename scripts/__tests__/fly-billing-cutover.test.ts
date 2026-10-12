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
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(mode = '') {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-test-')); dirs.push(dir);
  writeFileSync(join(dir, 'flyctl'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$CALLS"\nif [[ "$1 $2" == "config save" && "$MODE" == "save-fails" ]]; then exit 1; fi\nif [[ "$1 $2" == "machines list" ]]; then\n  if [[ "$MODE" == "remains" ]]; then echo '[{"id":"old","state":"stopped"}]'; else echo '[]'; fi\nfi\n`, { mode: 0o755 });
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
    for (const app of ['web', 'admin', 'realtime', 'processor', 'cron']) {
      expect(calls).toContain(`scale count 0 --app pagespace-${app} --yes`);
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

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('migration diagnostics', () => {
  it('captures allowlisted exit evidence and safe log summaries before cleanup, preserving failure status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fly-diagnostics-'));
    try {
      const machine = join(dir, 'machine.json');
      writeFileSync(machine, JSON.stringify({ state: 'stopped', config: { env: { PASSWORD: 'unknown-secret' } }, events: [{ type: 'exit', timestamp: 2, request: { config: { secret: 'unknown-secret' }, exit_event: { exited_at: '2026-10-15T18:40:30.498Z', exit_code: 1, signal: -1, secret: 'unknown-secret' } } }] }));
      const result = spawnSync('bash', ['-c', `
        source "$HELPER"
        flyctl() {
          if [ "$1" = logs ]; then
            echo 'migration failed postgres://owner:unknown-secret@db/database token=secret-value'
            echo logs >> "$ORDER"
          else
            echo cleanup >> "$ORDER"
          fi
        }
        timeout() { shift; "$@"; }
        trap capture_migration_diagnostics EXIT
        exit 7
      `], { encoding: 'utf8', env: { ...process.env, HELPER: resolve('fly-migration-diagnostics.sh'), MACHINE_JSON: machine, MACHINE_ID: '83d593c7662698', DIAGNOSTICS_DIR: join(dir, 'safe'), ORDER: join(dir, 'order') } });
      expect(result.status).toBe(7);
      expect(readFileSync(join(dir, 'order'), 'utf8')).toBe('logs\ncleanup\n');
      const events = readFileSync(join(dir, 'safe/events.json'), 'utf8');
      expect(events).toContain('exit_code');
      expect(events).not.toMatch(/config|unknown-secret|PASSWORD/);
      const logs = readFileSync(join(dir, 'safe/logs.txt'), 'utf8');
      expect(logs).toContain('migration failed');
      expect(logs).not.toMatch(/postgres|owner|secret|token/);
      expect(readdirSync(join(dir, 'safe')).sort()).toEqual(['events.json', 'logs.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

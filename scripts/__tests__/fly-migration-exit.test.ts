import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
function succeeds(machine: unknown) {
  return spawnSync('jq', ['-e', '-f', resolve('fly-migration-succeeded.jq')], { input: JSON.stringify(machine), encoding: 'utf8' }).status === 0;
}
const exit = { exited_at: '2026-10-12T00:00:00Z', exit_code: 0, guest_exit_code: 0 };
const machine = (event: unknown) => ({ state: 'stopped', events: [{ type: 'exit', timestamp: 2, request: { exit_event: event } }] });
describe('Fly migration completion evidence', () => {
  it('requires a successful exit event, not just stopped state', () => {
    expect(succeeds(machine(exit))).toBe(true);
    expect(succeeds({ state: 'stopped', events: [] })).toBe(false);
    expect(succeeds(machine({ ...exit, guest_exit_code: 1 }))).toBe(false);
    expect(succeeds(machine({ ...exit, exit_code: 1 }))).toBe(false);
    expect(succeeds(machine({ ...exit, oom_killed: true }))).toBe(false);
    expect(succeeds(machine({ ...exit, requested_stop: true }))).toBe(false);
  });
  it('understands Fly MonitorEvent and zero fields omitted by the Go API', () => {
    expect(succeeds({ state: 'stopped', events: [{ type: 'exit', timestamp: 2, request: { MonitorEvent: { exit_event: { exited_at: exit.exited_at } } } }] })).toBe(true);
  });
});

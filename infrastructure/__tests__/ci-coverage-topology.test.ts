import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

const root = resolve(__dirname, '../..');
type Step = { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, string | boolean> };
const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, { needs?: string[]; if?: string; strategy?: { 'fail-fast': boolean; matrix: { suite: string[] } }; steps: Step[] }>;
};
const unit = workflow.jobs['unit-tests'];
const coverageStep = unit.steps.find(step => step.name === 'Run tests with coverage (Node 24)')!;

// Exercise the workflow's actual shell selection and Turbo graph, without running
// builds or tests. This catches transitive application builds and omitted packages.
const graphs = ['lib', 'web', 'other'].map(suite => {
  const command = coverageStep.run!.replace('"${filters[@]}"', '"${filters[@]}" --dry=json');
  const result = JSON.parse(execFileSync('bash', ['-c', command], {
    cwd: root, env: { ...process.env, SUITE: suite }, encoding: 'utf8',
  })) as { tasks: { taskId: string; task: string; command: string }[] };
  return { suite, tasks: result.tasks };
});

describe('CI coverage topology', () => {
  test('assigns every Node 24 coverage script to exactly one runner, with no application builds', () => {
    expect(unit.strategy?.['fail-fast']).toBe(false);
    expect(unit.strategy?.matrix.suite).toEqual(graphs.map(graph => graph.suite));
    const expected = ['apps', 'packages'].flatMap(folder => readdirSync(resolve(root, folder)).flatMap(entry => {
      const path = resolve(root, folder, entry, 'package.json');
      if (!existsSync(path)) return [];
      const pkg = JSON.parse(readFileSync(path, 'utf8')) as { name: string; scripts?: Record<string, string> };
      return pkg.scripts?.['test:coverage'] && pkg.name !== '@pagespace/processor' ? [`${pkg.name}#test:coverage`] : [];
    })).sort();
    const actual = graphs.flatMap(graph => graph.tasks.filter(task => task.task === 'test:coverage' && task.command !== '<NONEXISTENT>').map(task => task.taskId)).sort();
    expect(actual).toEqual(expected);
    for (const graph of graphs) {
      expect(graph.tasks.filter(task => task.task === 'build').every(task => task.command.startsWith('tsc '))).toBe(true);
    }
    expect(graphs.find(graph => graph.suite === 'other')?.tasks.map(task => task.taskId)).toContain('@pagespace/lib#build');
    expect(unit.steps.some(step => step.run === 'bun run build')).toBe(false);
  });

  test('retains processor and all integration checks once, even when coverage fails', () => {
    for (const name of ['Run processor tests with coverage (Node 22)', 'Run backfill script tests', 'Run packages/db integration suites', 'Run packages/lib integration suites', 'Run apps/imago integration suites', 'Run Infisical store adapter integration suite', 'Run infrastructure tests', 'Check evidence manifest']) {
      const step = unit.steps.find(step => step.name === name)!;
      expect(step.if).toContain("matrix.suite == 'other'");
      expect(step.if).toContain('!cancelled()');
      expect(step.if).toContain(".outcome == 'success'");
    }
  });

  test('merges disjoint suite artifacts before the existing spec-ID consumer runs', () => {
    const report = workflow.jobs['coverage-report'];
    expect(report.needs).toEqual(['unit-tests']);
    expect(report.if).toBe('always()');
    expect(report.steps.filter(step => step.uses?.startsWith('actions/download-artifact')).map(step => step.with)).toEqual([
      { pattern: 'coverage-*', 'merge-multiple': true },
      { pattern: 'vitest-json-*', 'merge-multiple': true },
    ]);
    expect(report.steps.filter(step => step.uses?.startsWith('actions/upload-artifact')).map(step => step.with?.name)).toEqual(['coverage-reports', 'vitest-json-results']);
    expect(workflow.jobs['spec-coverage'].needs).toContain('coverage-report');
    expect(workflow.jobs['spec-coverage'].steps.find(step => step.name === 'Download Vitest JSON results')?.with?.name).toBe('vitest-json-results');
  });
});

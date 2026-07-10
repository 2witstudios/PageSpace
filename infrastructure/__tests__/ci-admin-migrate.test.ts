import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const WORKFLOW_PATH = resolve(__dirname, '../../.github/workflows/docker-images.yml');

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}

interface WorkflowFile {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
}

function loadWorkflow(): WorkflowFile {
  const raw = readFileSync(WORKFLOW_PATH, 'utf-8');
  return parse(raw) as WorkflowFile;
}

describe('docker-images.yml admin-DB migrate step', () => {
  const workflow = loadWorkflow();
  const steps = workflow.jobs['deploy-fly'].steps ?? [];
  const mainIdx = steps.findIndex(s => s.name === 'Run migrations');
  const adminIdx = steps.findIndex(s => s.name === 'Run admin migrations');
  const adminStep = steps[adminIdx];

  it('given the deploy-fly job, should define a "Run admin migrations" step', () => {
    expect(adminStep).toBeDefined();
  });

  it('given the admin migrations step, should run directly after the main "Run migrations" step', () => {
    expect(mainIdx).toBeGreaterThanOrEqual(0);
    expect(adminIdx).toBe(mainIdx + 1);
  });

  it('given the admin migrations step, should be conditional on the admin DB being provisioned', () => {
    expect(adminStep.if).toBeDefined();
    expect(adminStep.if).toContain('ADMIN_DB_MIGRATIONS_ENABLED');
  });

  it('given the admin migrations step, should run db:migrate:admin on a one-shot machine', () => {
    expect(adminStep.run).toContain('flyctl machine run');
    expect(adminStep.run).toContain('db:migrate:admin');
  });

  it('given the admin migrations step, should use the same migrate image as the main step', () => {
    expect(adminStep.run).toContain('pagespace-migrate:latest');
  });

  it('given the admin migrations step, should fail on failed/destroyed machine states like the main step', () => {
    expect(adminStep.run).toContain('failed');
    expect(adminStep.run).toContain('destroyed');
  });

  it('given the main migrations step, should NOT be conditional (main DB always migrates)', () => {
    expect(steps[mainIdx].if).toBeUndefined();
  });
});

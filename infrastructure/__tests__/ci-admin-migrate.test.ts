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

  // The one-shot-machine mechanics (flyctl machine run, polling for
  // failed/destroyed states) live in scripts/deploy/run-fly-migration.sh —
  // shared by both the main and admin migration steps, so it's tested once
  // there (scripts/deploy is not a vitest project; verified by reading the
  // script directly below) instead of duplicated inline in each step.
  const RUN_FLY_MIGRATION_SCRIPT = readFileSync(
    resolve(__dirname, '../../scripts/deploy/run-fly-migration.sh'),
    'utf-8'
  );

  it('given the admin migrations step, should run db:migrate:admin via the shared one-shot-machine script', () => {
    expect(adminStep.run).toContain('scripts/deploy/run-fly-migration.sh');
    expect(adminStep.run).toContain('db:migrate:admin');
  });

  it('given the shared one-shot-machine script, should run flyctl machine run', () => {
    expect(RUN_FLY_MIGRATION_SCRIPT).toContain('flyctl machine run');
  });

  it('given the admin migrations step, should use the same migrate image as the main step', () => {
    const imageOf = (run?: string) => run?.match(/ghcr\.io\/2witstudios\/pagespace-migrate\b/)?.[0];
    expect(imageOf(adminStep.run)).toBeDefined();
    expect(imageOf(adminStep.run)).toBe(imageOf(steps[mainIdx].run));
  });

  it('given the admin and main migrations steps, should never pin the mutable :latest tag', () => {
    expect(adminStep.run).not.toContain('pagespace-migrate:latest');
    expect(steps[mainIdx].run).not.toContain('pagespace-migrate:latest');
  });

  it('given the admin migrations step, should delegate to the same script as the main step (so it fails on failed/destroyed machine states identically)', () => {
    expect(adminStep.run).toContain('scripts/deploy/run-fly-migration.sh');
    expect(steps[mainIdx].run).toContain('scripts/deploy/run-fly-migration.sh');
  });

  it('given the shared one-shot-machine script, should fail on failed/destroyed machine states', () => {
    expect(RUN_FLY_MIGRATION_SCRIPT).toContain('failed');
    expect(RUN_FLY_MIGRATION_SCRIPT).toContain('destroyed');
  });

  it('given the main migrations step, should NOT be conditional (main DB always migrates)', () => {
    expect(steps[mainIdx].if).toBeUndefined();
  });

  // #890 Phase 2 (leaf 0): the machine runs in the pagespace-web app, whose
  // runtime ADMIN_DATABASE_URL secret is the least-privilege admin_app LOGIN.
  // Migrations need the OWNER role, so the workflow passes a dedicated
  // ADMIN_DATABASE_URL_MIGRATE from a GitHub secret to the one-shot machine —
  // owner credentials never live in any Fly app's runtime secrets.
  describe('owner-credential scoping (ADMIN_DATABASE_URL_MIGRATE)', () => {
    it('given the admin migrations step, should pass ADMIN_DATABASE_URL_MIGRATE to the one-shot machine via --env', () => {
      expect(adminStep.run).toMatch(/--env\s+ADMIN_DATABASE_URL_MIGRATE=/);
    });

    it('given the admin migrations step, should source ADMIN_DATABASE_URL_MIGRATE from GitHub secrets', () => {
      expect(adminStep.env?.ADMIN_DATABASE_URL_MIGRATE).toContain('secrets.ADMIN_DATABASE_URL_MIGRATE');
    });

    it('given the admin migrations step, should fail fast when the migrate secret is missing (never fall back to the runtime login)', () => {
      expect(adminStep.run).toMatch(/-z\s+"?\$\{?ADMIN_DATABASE_URL_MIGRATE\}?"?/);
      expect(adminStep.run).toContain('exit 1');
    });
  });
});

/**
 * docker-images.yml credential plane steps (agent accounts slice 1, deploy).
 * Pins the properties a careless edit would break: both steps stay behind the
 * CREDENTIAL_PLANE_ENABLED gate, the one-shot gets the OWNER URL under its own
 * name and runs inside the plane's app, its machine is cleaned up there, and the
 * plane rolls out before web (web calls the plane's routes).
 */
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

const steps = (parse(readFileSync(WORKFLOW_PATH, 'utf-8')) as WorkflowFile).jobs['deploy-fly'].steps ?? [];
const indexOf = (name: string) => steps.findIndex((step) => step.name === name);
const migrate = steps[indexOf('Run credential plane migrations')];
const deploy = steps[indexOf('Deploy credential plane')];

describe('docker-images.yml credential plane steps', () => {
  it('given the deploy-fly job, should define both the migration and the deploy step', () => {
    expect({ migrate: migrate !== undefined, deploy: deploy !== undefined }).toEqual({ migrate: true, deploy: true });
  });

  it('given both steps, should be gated on CREDENTIAL_PLANE_ENABLED', () => {
    expect([migrate.if, deploy.if]).toEqual([
      "${{ vars.CREDENTIAL_PLANE_ENABLED == 'true' }}",
      "${{ vars.CREDENTIAL_PLANE_ENABLED == 'true' }}",
    ]);
  });

  it('given the migration step, should pass the owner URL under its own name from a GitHub secret, never the runtime name', () => {
    const actual = {
      fromSecret: migrate.env?.PLANE_METADATA_DATABASE_URL_MIGRATE,
      viaEnvFlag: migrate.run?.includes('--env PLANE_METADATA_DATABASE_URL_MIGRATE="$PLANE_METADATA_DATABASE_URL_MIGRATE"'),
      setsRuntimeName: /--env PLANE_METADATA_DATABASE_URL=/.test(migrate.run ?? ''),
    };
    expect(actual).toEqual({ fromSecret: '${{ secrets.PLANE_METADATA_DATABASE_URL_MIGRATE }}', viaEnvFlag: true, setsRuntimeName: false });
  });

  it('given the migration step, should run credential-plane:migrate in the plane app and clean its machine up there', () => {
    const run = migrate.run ?? '';
    const actual = {
      command: run.includes('credential-plane:migrate'),
      app: run.includes('--app pagespace-credential-plane'),
      diagnosticsApp: run.includes('export MIGRATION_APP=pagespace-credential-plane'),
      failsOnBadState: run.includes('failed') && run.includes('destroyed'),
    };
    expect(actual).toEqual({ command: true, app: true, diagnosticsApp: true, failsOnBadState: true });
  });

  it('given the deploy order, should migrate after the main and admin migrations and deploy the plane before web', () => {
    const actual = {
      afterAdminMigrations: indexOf('Run credential plane migrations') > indexOf('Run admin migrations'),
      migrateBeforeDeploy: indexOf('Run credential plane migrations') < indexOf('Deploy credential plane'),
      planeBeforeWeb: indexOf('Deploy credential plane') < indexOf('Deploy web'),
    };
    expect(actual).toEqual({ afterAdminMigrations: true, migrateBeforeDeploy: true, planeBeforeWeb: true });
  });
});

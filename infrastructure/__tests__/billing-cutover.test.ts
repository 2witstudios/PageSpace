import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

describe('Compose personal billing cutover', () => {
  it.each(['../../docker-compose.yml', '../docker-compose.tenant.yml'])(
    'given %s, should forward an explicit offline assertion and default to refusal',
    (file) => {
      const compose = parse(readFileSync(resolve(__dirname, file), 'utf8')) as {
        services: { migrate: { environment: Record<string, string> | string[] } };
      };
      const env = compose.services.migrate.environment;
      const assertion = Array.isArray(env)
        ? env.find(value => value.startsWith('BILLING_CUTOVER_OFFLINE='))?.slice('BILLING_CUTOVER_OFFLINE='.length)
        : env.BILLING_CUTOVER_OFFLINE;
      expect(assertion).toBe('${BILLING_CUTOVER_OFFLINE:-false}');
    },
  );
});

describe('cutover preparation and recovery workflow', () => {
  const workflow = parse(readFileSync(resolve(__dirname, '../../.github/workflows/docker-images.yml'), 'utf8')) as {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; default: unknown }> } };
    env: Record<string, string>;
    jobs: Record<string, {
      if?: string;
      env?: Record<string, string>;
      steps: Array<{ name?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, string> }>;
    }>;
  };

  it('image-only preparation cannot deploy or replace the production latest tags', () => {
    expect(workflow.on.workflow_dispatch.inputs.build_only).toMatchObject({ type: 'boolean', default: false });
    expect(workflow.jobs['deploy-fly'].if).toContain('inputs.build_only != true');
    const tags = String(workflow.jobs['build-and-push'].steps.find(step => step.name === 'Extract metadata')?.with?.tags);
    expect(tags).toContain('type=raw,value=latest,enable=${{ inputs.build_only != true }}');
    expect(tags).toContain('type=raw,value=sha-${{ github.sha }}');
  });

  it('a new recovery run can download the original sealed topology from its recorded run ID', () => {
    expect(workflow.on.workflow_dispatch.inputs.topology_run_id.type).toBe('string');
    const download = workflow.jobs['deploy-fly'].steps.find(step => step.name === 'Resume from the durable topology snapshot');
    expect(download?.with?.['run-id']).toBe('${{ inputs.topology_run_id || github.run_id }}');
    expect(download?.with?.['github-token']).toBe('${{ github.token }}');
  });

  it('billing cutover migration and all drained services use images bound to the candidate SHA', () => {
    const run = workflow.jobs['deploy-fly'].steps.map(step => step.run ?? '').join('\n');
    expect(run).toContain('scripts/deploy/run-fly-migration.sh pagespace-web \\\n  ghcr.io/2witstudios/pagespace-migrate "$RELEASE_IMAGE_TAG"');
    for (const app of ['web', 'admin', 'realtime', 'processor', 'cron']) {
      expect(run).toContain(`scripts/deploy/deploy-fly-service.sh pagespace-${app} \\\n  ghcr.io/2witstudios/pagespace-${app} "$RELEASE_IMAGE_TAG"`);
    }
    // The shared scripts retag that exact GHCR tag into Fly's registry and deploy it.
    const migrate = readFileSync(resolve(__dirname, '../../scripts/deploy/run-fly-migration.sh'), 'utf8');
    expect(migrate).toContain('FLY_IMAGE="registry.fly.io/${FLY_APP}:migrate-${TAG}"');
    const deploy = readFileSync(resolve(__dirname, '../../scripts/deploy/deploy-fly-service.sh'), 'utf8');
    expect(deploy).toContain('FLY_IMAGE="registry.fly.io/${FLY_APP}:${TAG}"');
    expect(deploy).toContain('--image "$FLY_IMAGE"');
  });

  it('every deploy pins the immutable full-SHA tag, never the mutable latest tag', () => {
    expect(workflow.env.RELEASE_IMAGE_TAG).toBe('sha-${{ github.sha }}');
  });

  it('the main migration forwards the offline cutover assertion only for a billing cutover run', () => {
    const step = workflow.jobs['deploy-fly'].steps.find(s => s.name === 'Run migrations');
    expect(step?.run).toContain('--env "BILLING_CUTOVER_OFFLINE=$BILLING_CUTOVER_OFFLINE"');
    expect(step?.env?.BILLING_CUTOVER_OFFLINE).toBe("${{ inputs.billing_cutover == true && 'true' || 'false' }}");
  });

  it('drained services deploy with the snapshotted config and restore their fleet', () => {
    expect(workflow.jobs['deploy-fly'].env?.CUTOVER_DIR).toBe('/tmp/pagespace-cutover');
    const deploy = readFileSync(resolve(__dirname, '../../scripts/deploy/deploy-fly-service.sh'), 'utf8');
    expect(deploy).toContain('config_args=(--config "$CUTOVER_DIR/$FLY_APP.toml")');
    expect(deploy).toContain('bash "$SCRIPTS_DIR/fly-billing-restore.sh" "$CUTOVER_DIR" "$FLY_APP"');
  });
});

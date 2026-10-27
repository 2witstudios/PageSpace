import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const WORKFLOW_PATH = resolve(__dirname, '../../.github/workflows/docker-images.yml');
const RUN_FLY_MIGRATION_SCRIPT_PATH = resolve(__dirname, '../../scripts/deploy/run-fly-migration.sh');

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
  // shared by the main, admin and staging migration steps, so it's tested once
  // (statically here, end-to-end under "migration polling behavior" below)
  // instead of duplicated inline in each step.
  const RUN_FLY_MIGRATION_SCRIPT = readFileSync(RUN_FLY_MIGRATION_SCRIPT_PATH, 'utf-8');

  it('given the admin migrations step, should run db:migrate:admin via the shared one-shot-machine script', () => {
    expect(adminStep.run).toContain('scripts/deploy/run-fly-migration.sh');
    expect(adminStep.run).toContain('db:migrate:admin');
  });

  it('given the shared one-shot-machine script, should run flyctl machine run', () => {
    expect(RUN_FLY_MIGRATION_SCRIPT).toContain('flyctl machine run');
  });

  it('given the admin migrations step, should use the same migrate image and release tag as the main step', () => {
    for (const run of [adminStep.run, steps[mainIdx].run]) {
      expect(run).toContain('ghcr.io/2witstudios/pagespace-migrate "$RELEASE_IMAGE_TAG"');
    }
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

describe('migration evidence and diagnostics guards', () => {
  const steps = loadWorkflow().jobs['deploy-fly'].steps ?? [];
  const script = readFileSync(RUN_FLY_MIGRATION_SCRIPT_PATH, 'utf-8');
  it.each(['Run migrations', 'Run admin migrations'])('%s delegates to the evidence-checking script with its own diagnostics dir', name => {
    const step = steps.find(s => s.name === name);
    expect(step?.run).toContain('scripts/deploy/run-fly-migration.sh pagespace-web');
    expect(step?.env?.DIAGNOSTICS_DIR).toContain('${{ runner.temp }}/migration-diagnostics/');
  });
  it('the shared script waits for evidence and preserves diagnostics', () => {
    expect(script).toContain('--arg mode failed');
    expect(script).toContain('TIMEOUT=900');
    expect(script).toContain('trap capture_migration_diagnostics EXIT');
    expect(script).not.toContain('flyctl machine logs');
    expect(script).toContain('Exit evidence pending');
  });
  it('uploads only the sanitized directory even after failure', () => {
    const upload = steps.find(step => step.name === 'Upload migration diagnostics');
    expect(upload?.if).toBe('always()');
    expect(upload).toMatchObject({ with: { path: '${{ runner.temp }}/migration-diagnostics' } });
  });
});

describe('Imago release deployment', () => {
  it('deploys the built Imago release after web and before marketing without changing runtime flags', () => {
    const steps = loadWorkflow().jobs['deploy-fly'].steps ?? [];
    const imagoIndex = steps.findIndex(step => step.name === 'Deploy imago');
    expect(imagoIndex).toBeGreaterThan(steps.findIndex(step => step.name === 'Deploy web'));
    expect(imagoIndex).toBeLessThan(steps.findIndex(step => step.name === 'Deploy marketing'));
    const run = steps[imagoIndex]?.run ?? '';
    expect(run).toContain('pagespace-imago:$RELEASE_IMAGE_TAG');
    expect(run).toContain('flyctl deploy --app pagespace-imago --image "registry.fly.io/pagespace-imago:$RELEASE_IMAGE_TAG" --yes');
    expect(run).not.toContain('IMAGO_ENABLED');
  });
});

describe('migration polling behavior', () => {
  // Runs the real scripts/deploy/run-fly-migration.sh end-to-end (the script both
  // staging and prod migrations use), with docker/flyctl/curl/sleep/timeout stubbed
  // as exported bash functions so no network or Fly account is touched.
  it.each(['pagespace-web', 'pagespace-web-staging'])('%s waits for delayed evidence and fails promptly on a bad exit', async app => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, rmSync, readFileSync: read } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(resolve(tmpdir(), 'fly-poll-'));
    try {
      for (const scenario of ['delayed', 'failed', 'missing']) {
        const result = spawnSync('bash', ['-c', `
          docker() { :; }
          flyctl() {
            echo "flyctl $*" >> "$CALLS"
            if [ "$1 $2" = "machine run" ]; then echo "Machine ID: 0123abcd"; echo "Error: failed to reach desired start state"; fi
          }
          timeout() { shift; "$@"; }
          curl() {
            local output count
            while [ "$#" -gt 0 ]; do
              if [ "$1" = -o ]; then output="$2"; shift; fi
              shift
            done
            count=$(cat "$COUNTER" 2>/dev/null || echo 0)
            count=$((count + 1))
            echo "$count" > "$COUNTER"
            if [ "$SCENARIO" = failed ]; then
              printf '%s' '{"state":"stopped","events":[{"type":"exit","timestamp":1,"request":{"exit_event":{"exited_at":"2026-10-15T18:40:30.498Z","exit_code":1}}}]}' > "$output"
            elif [ "$SCENARIO" = delayed ] && [ "$count" -gt 1 ]; then
              printf '%s' '{"state":"stopped","events":[{"type":"exit","timestamp":1,"request":{"MonitorEvent":{"exit_event":{"exited_at":"2026-10-15T18:40:30.498Z","signal":-1,"guest_signal":-1}}}}]}' > "$output"
            else
              printf '%s' '{"state":"stopped","events":[]}' > "$output"
            fi
            printf 200
          }
          sleep() { :; }
          export -f docker flyctl timeout curl sleep
          bash "$SCRIPT" "$APP" ghcr.io/2witstudios/pagespace-migrate sha-test
        `], {
          encoding: 'utf8',
          env: {
            ...process.env,
            SCRIPT: RUN_FLY_MIGRATION_SCRIPT_PATH,
            APP: app,
            SCENARIO: scenario,
            COUNTER: resolve(dir, `${scenario}.count`),
            CALLS: resolve(dir, `${scenario}.calls`),
            DIAGNOSTICS_DIR: resolve(dir, `${scenario}-diagnostics`),
            FLY_API_TOKEN: 'fake',
          },
        });
        expect(result.status, result.stderr).toBe(scenario === 'delayed' ? 0 : 1);
        if (scenario === 'delayed') {
          expect(result.stdout).toContain('Exit evidence pending');
          expect(result.stdout).toContain('[10s]');
        } else if (scenario === 'failed') {
          expect(result.stdout).toContain('exit evidence indicates failure');
          expect(result.stdout).not.toContain('[10s]');
        } else {
          expect(result.stdout).toContain('timed out after 900s');
        }
        // Success or failure, the EXIT trap destroys the one-shot machine in the
        // app it ran in (never a hard-coded one).
        expect(read(resolve(dir, `${scenario}.calls`), 'utf8')).toContain(`flyctl machine destroy 0123abcd --app ${app} --force`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The "missing" scenario walks all 90 polls of the 900s deadline (sleep stubbed).
  }, 60_000);
});

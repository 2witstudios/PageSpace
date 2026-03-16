import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const WORKFLOW_PATH = resolve(__dirname, '../../../.github/workflows/docker-images.yml');

interface MatrixEntry {
  service: string;
  dockerfile: string;
  context: string;
}

interface Workflow {
  name: string;
  on: {
    push: {
      branches: string[];
      tags: string[];
    };
  };
  env: Record<string, string>;
  jobs: {
    'build-and-push': {
      strategy: {
        matrix: {
          include: MatrixEntry[];
        };
      };
      steps: Array<{ uses?: string; with?: Record<string, string>; name?: string; id?: string }>;
    };
  };
}

function loadWorkflow(): Workflow {
  const raw = readFileSync(WORKFLOW_PATH, 'utf-8');
  return parse(raw) as Workflow;
}

const EXPECTED_SERVICES: Record<string, { dockerfile: string; context: string }> = {
  web: { dockerfile: 'apps/web/Dockerfile', context: '.' },
  migrate: { dockerfile: 'apps/web/Dockerfile.migrate', context: '.' },
  realtime: { dockerfile: 'apps/realtime/Dockerfile', context: '.' },
  processor: { dockerfile: 'apps/processor/Dockerfile', context: '.' },
  cron: { dockerfile: 'docker/cron/Dockerfile', context: 'docker/cron' },
};

describe('Docker Images CI workflow', () => {
  const workflow = loadWorkflow();
  const matrix = workflow.jobs['build-and-push'].strategy.matrix.include;
  const serviceNames = matrix.map((e) => e.service);

  describe('service matrix', () => {
    it('should include all 5 required services', () => {
      expect(serviceNames).toHaveLength(5);
      for (const name of Object.keys(EXPECTED_SERVICES)) {
        expect(serviceNames).toContain(name);
      }
    });

    it.each(Object.entries(EXPECTED_SERVICES))(
      '%s should reference the correct Dockerfile',
      (service, expected) => {
        const entry = matrix.find((e) => e.service === service);
        expect(entry).toBeDefined();
        expect(entry!.dockerfile).toBe(expected.dockerfile);
      },
    );

    it.each(Object.entries(EXPECTED_SERVICES))(
      '%s should use the correct build context',
      (service, expected) => {
        const entry = matrix.find((e) => e.service === service);
        expect(entry).toBeDefined();
        expect(entry!.context).toBe(expected.context);
      },
    );
  });

  describe('trigger configuration', () => {
    it('should trigger on master branch push', () => {
      expect(workflow.on.push.branches).toContain('master');
    });

    it('should trigger on semver tag push', () => {
      const tags = workflow.on.push.tags;
      expect(tags).toBeDefined();
      expect(tags.length).toBeGreaterThan(0);
      // Should have a v*.*.* pattern
      const hasSemverPattern = tags.some((t: string) => /^v\*/.test(t));
      expect(hasSemverPattern).toBe(true);
    });
  });

  describe('tag patterns', () => {
    const steps = workflow.jobs['build-and-push'].steps;
    const metaStep = steps.find((s) => s.id === 'meta');
    const tagsConfig = metaStep?.with?.tags ?? '';

    it('should produce a latest tag', () => {
      expect(tagsConfig).toContain('type=raw,value=latest');
    });

    it('should produce a sha-prefixed tag', () => {
      expect(tagsConfig).toMatch(/type=sha,prefix=sha-/);
    });

    it('should produce a semver tag on version pushes', () => {
      expect(tagsConfig).toMatch(/type=semver/);
    });
  });

  describe('image naming', () => {
    it('should target GHCR registry', () => {
      expect(workflow.env.REGISTRY).toBe('ghcr.io');
    });

    it('should use the correct image prefix', () => {
      expect(workflow.env.IMAGE_PREFIX).toMatch(/^ghcr\.io\/.+\/pagespace$/);
    });
  });

  describe('GHCR authentication', () => {
    const steps = workflow.jobs['build-and-push'].steps;
    const loginStep = steps.find((s) => s.uses?.startsWith('docker/login-action'));

    it('should authenticate to GHCR using GITHUB_TOKEN', () => {
      expect(loginStep).toBeDefined();
      // The registry value references the env var that resolves to ghcr.io
      const registry = loginStep!.with?.registry ?? '';
      expect(registry === 'ghcr.io' || registry.includes('REGISTRY')).toBe(true);
      expect(loginStep!.with?.password).toContain('GITHUB_TOKEN');
    });
  });

  describe('build configuration', () => {
    const steps = workflow.jobs['build-and-push'].steps;
    const buildStep = steps.find((s) => s.uses?.startsWith('docker/build-push-action'));

    it('should enable layer caching', () => {
      expect(buildStep?.with?.['cache-from']).toBeDefined();
      expect(buildStep?.with?.['cache-to']).toBeDefined();
    });

    it('should push images', () => {
      expect(String(buildStep?.with?.push)).toBe('true');
    });
  });
});

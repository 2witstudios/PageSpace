/**
 * Dockerfile ARG validation tests
 * Ensures build-time variables are configured correctly for multi-tenant reuse.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const dockerfile = readFileSync(
  join(__dirname, '../../../apps/web/Dockerfile'),
  'utf-8'
);
const nextConfig = readFileSync(
  join(__dirname, '../../../apps/web/next.config.ts'),
  'utf-8'
);
const ciWorkflow = readFileSync(
  join(__dirname, '../../../.github/workflows/ci.yml'),
  'utf-8'
);
const spritesClient = readFileSync(
  join(__dirname, '../../../apps/web/src/lib/sandbox/sprites-client.ts'),
  'utf-8'
);

describe('Dockerfile build args', () => {
  it('given the Dockerfile, should have NEXT_PUBLIC_REALTIME_URL ARG with empty default', () => {
    const match = dockerfile.match(/^ARG NEXT_PUBLIC_REALTIME_URL(.*)$/m);
    expect(match).not.toBeNull();
    // Should have an empty default (="" or no value after =)
    expect(match![1]).toMatch(/^="?"?$/);
  });

  it('given the Dockerfile, should NOT have tenant-specific secrets as ARGs', () => {
    const argLines = dockerfile.match(/^ARG .+$/gm) || [];
    const secretPatterns = [
      /DATABASE_URL/,
      /SECRET/,
      /PASSWORD/,
      /PRIVATE_KEY/,
      /API_KEY(?!.*NEXT_PUBLIC)/,
    ];

    for (const arg of argLines) {
      for (const pattern of secretPatterns) {
        expect(arg).not.toMatch(pattern);
      }
    }
  });

  it('given the Dockerfile, should still have NEXT_PUBLIC_APP_URL as a build ARG', () => {
    expect(dockerfile).toMatch(/^ARG NEXT_PUBLIC_APP_URL$/m);
  });

  it('given the Dockerfile, should still have NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB as a build ARG', () => {
    expect(dockerfile).toMatch(/^ARG NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB$/m);
  });

  it('given the Dockerfile, should not manually copy @fly/sprites from Bun internals', () => {
    expect(dockerfile).not.toContain('@fly+sprites');
    expect(dockerfile).not.toContain('node_modules/.bun/node_modules/@fly/sprites');
    expect(dockerfile).not.toContain('cp -a');
  });

  it('given the web app boundary, should statically import @fly/sprites and keep it bundled', () => {
    expect(spritesClient).toMatch(/import\s+\{\s*SpritesClient\s*\}\s+from\s+['"]@fly\/sprites['"]/);
    expect(nextConfig).toMatch(/serverExternalPackages:\s*\[\s*["']pg["']\s*\]/);
    expect(nextConfig).not.toMatch(/serverExternalPackages:[\s\S]*@fly\/sprites/);
  });

  // The production image (docker-images.yml) builds apps/web with this Dockerfile. CI raised its
  // heap to 6144 after Next's build OOMed at Node's ~4GB default (#2740); a Dockerfile left at 4096
  // can fail the image build at deploy time, so the default must match CI's ceiling and stay
  // overridable for a self-hosted builder with less memory.
  it('given the Dockerfile, the web build heap defaults to the CI ceiling and is a build ARG', () => {
    const ciHeaps = [...ciWorkflow.matchAll(/NODE_OPTIONS: --max-old-space-size=(\d+)/g)].map((m) => Number(m[1]));
    expect(ciHeaps.length).toBeGreaterThan(0);
    const ciCeiling = Math.max(...ciHeaps);

    const arg = dockerfile.match(/^ARG WEB_BUILD_MAX_OLD_SPACE_MB=(\d+)$/m);
    expect(arg).not.toBeNull();
    expect(Number(arg![1])).toBe(ciCeiling);

    const buildLine = dockerfile.match(/^RUN cd apps\/web && .*bun run build$/m);
    expect(buildLine).not.toBeNull();
    expect(buildLine![0]).toContain('--max-old-space-size=${WEB_BUILD_MAX_OLD_SPACE_MB}');
    expect(dockerfile).not.toMatch(/max-old-space-size=4096/);
  });
});

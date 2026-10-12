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

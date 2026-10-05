import { readFileSync } from 'fs';
import path from 'path';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';

const appsDir = path.resolve(__dirname, '../..');
const readEnvExample = (app: string) =>
  readFileSync(path.join(appsDir, app, '.env.example'), 'utf8');

// A documented variable is an assignment line, live or commented out.
const documents = (envExample: string, name: string) =>
  new RegExp(`^#?\\s*${name}=`, 'm').test(envExample);

const IMAGO_DEV_ORIGIN = 'http://localhost:3006';

describe('.env.example documentation for the imago dev topology', () => {
  for (const app of ['web', 'realtime', 'imago']) {
    test(`apps/${app}/.env.example`, () => {
      const envExample = readEnvExample(app);

      for (const name of ['WEB_APP_INTERNAL_URL', 'NEXT_PUBLIC_REALTIME_URL']) {
        assert({
          given: `apps/${app}/.env.example`,
          should: `document ${name}`,
          actual: documents(envExample, name),
          expected: true,
        });
      }

      assert({
        given: `apps/${app}/.env.example`,
        should: 'document the imago dev origin',
        actual: envExample.includes(IMAGO_DEV_ORIGIN),
        expected: true,
      });
    });
  }

  for (const app of ['web', 'realtime']) {
    test(`apps/${app} allowed origins`, () => {
      assert({
        given: `apps/${app}/.env.example`,
        should: 'show the imago origin as an ADDITIONAL_ALLOWED_ORIGINS value',
        actual: new RegExp(`^#?\\s*ADDITIONAL_ALLOWED_ORIGINS=.*${IMAGO_DEV_ORIGIN}`, 'm').test(
          readEnvExample(app),
        ),
        expected: true,
      });
    });
  }
});

/**
 * toolActor is imported by the sandbox tool modules, whose tool-name catalogs client code imports
 * (core/tool-filtering). A runtime import here would ship the server-only permission layer to the
 * browser, where module evaluation throws and the app renders its error boundary (the agent-session
 * e2e run caught exactly that). So the module may hold type-only imports, nothing else.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import type { ToolExecutionContext } from '../../core/types';
import { toolActor } from '../tool-actor';

describe('toolActor', () => {
  it('returns the context actor when it is the context user', () => {
    const actor = credentialActor('user-1', null);
    expect(toolActor({ userId: 'user-1', accessActor: actor } as ToolExecutionContext)).toBe(actor);
  });

  it('refuses a context whose actor is another user', () => {
    expect(() => toolActor({ userId: 'user-2', accessActor: credentialActor('user-1', null) } as ToolExecutionContext)).toThrow(
      'Tool context actor does not match its user',
    );
  });

  it('has no runtime imports, so the browser bundles that reach it pull nothing server-only', () => {
    const source = readFileSync(join(__dirname, '..', 'tool-actor.ts'), 'utf8');
    const imports = source.split('\n').filter((line) => /^import\s/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((line) => !/^import type\s/.test(line))).toEqual([]);
  });
});

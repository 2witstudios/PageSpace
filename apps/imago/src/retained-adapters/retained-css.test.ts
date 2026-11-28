import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';

const sheet = postcss.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'retained.generated.css'), 'utf8'));

/** The retained scale's own value for a token, as its theme layer declares it on the scope. */
const retainedToken = (name: string): string | undefined => {
  let value: string | undefined;
  sheet.walkAtRules('layer', (layer) => {
    if (layer.params !== 'theme' || value !== undefined) return;
    layer.walkDecls(name, (decl) => {
      value ??= decl.value;
    });
  });
  return value;
};

/** What the retained coarse-pointer field rule sets, by property. */
const retainedFieldFloor = (): Map<string, string> => {
  const decls = new Map<string, string>();
  sheet.walkAtRules('media', (media) => {
    if (media.params !== '(pointer: coarse)') return;
    media.walkRules((rule) => {
      if (!rule.selector.startsWith(':scope :is(input')) return;
      rule.walkDecls((decl) => {
        decls.set(decl.prop, decl.value);
      });
    });
  });
  return decls;
};

describe('the retained touch-screen field floor', () => {
  test('retained fields floor against the retained scale, so the text-size setting still scales them', () => {
    const sizes = ['--text-2xs', '--text-xs', '--text-sm', '--text-base', '--text-chat'];
    const floor = retainedFieldFloor();

    assert({
      given: 'a field inside a retained surface on a touch screen',
      should: 'floor each type token at 16px over the retained scale’s own rem (text-base is 1rem there, not imago’s 0.875rem)',
      actual: sizes.map((name) => floor.get(name)),
      expected: sizes.map((name) => `max(16px, ${retainedToken(name)})`),
    });

    assert({
      given: 'the retained scale',
      should: 'be Tailwind’s default steps plus imago’s chat and 2xs',
      actual: sizes.map(retainedToken),
      expected: ['0.6875rem', '0.75rem', '0.875rem', '1rem', '0.9375rem'],
    });
  });
});

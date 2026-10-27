import { describe, it, expect } from 'vitest';
import { tokenizeCode } from '../shiki-highlighter';

/**
 * Empirical coverage check for the Shiki JS-regex-engine switch (CSP fix:
 * avoids 'wasm-unsafe-eval'). The JS engine cannot compile every Oniguruma
 * regex construct some TextMate grammars use, so this verifies every
 * language actually offered in LanguageSelector.tsx still produces real,
 * multi-colored highlighting (not a silent fall-through to plain, single-
 * color text) under the JS engine — not just that it doesn't throw.
 */
describe('Shiki JS engine — language coverage (LanguageSelector.tsx languages)', () => {
  const samples: Record<string, string> = {
    javascript: 'const x = 1; function f() { return x + 1; }',
    typescript: 'interface Foo { bar: string } const x: Foo = { bar: "a" };',
    python: 'def foo(x):\n    return x + 1\n\nclass Bar:\n    pass',
    html: '<div class="x"><p>hello</p></div>',
    css: '.foo { color: red; background: blue; }',
    json: '{"a": 1, "b": [true, false, null]}',
    markdown: '# Title\n\n**bold** and _italic_ and `code`',
    bash: 'for i in 1 2 3; do echo "$i"; done',
    sql: "SELECT id, name FROM users WHERE active = TRUE ORDER BY id;",
    rust: 'fn main() { let x: i32 = 1; println!("{}", x); }',
    go: 'package main\nfunc main() { x := 1; fmt.Println(x) }',
    yaml: 'foo: bar\nlist:\n  - a\n  - b\n',
  };

  for (const [lang, code] of Object.entries(samples)) {
    it(`tokenizes ${lang} with more than one distinct color (real highlighting, not a plain-text fallback)`, async () => {
      const tokens = await tokenizeCode(code, lang, 'one-light');
      const flat = tokens.flat();
      expect(flat.length, `${lang}: expected at least one token`).toBeGreaterThan(0);

      const distinctColors = new Set(flat.map((t) => t.color).filter(Boolean));
      expect(
        distinctColors.size,
        `${lang}: expected multiple distinct token colors (real syntax highlighting); got ${distinctColors.size} — ` +
          `possible silent fallback to plain text under the JS regex engine`,
      ).toBeGreaterThan(1);
    });
  }
});

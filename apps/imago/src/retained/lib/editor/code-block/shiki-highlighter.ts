import {
  createHighlighter,
  type Highlighter,
  type ThemedToken,
  type BundledLanguage,
  type BundledTheme,
} from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { sudolangGrammar } from './sudolang-grammar';

export type ShikiTheme = 'one-light' | 'one-dark-pro';

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['one-light', 'one-dark-pro'],
      langs: [sudolangGrammar],
      // The default oniguruma engine instantiates a WASM module client-side,
      // which requires 'wasm-unsafe-eval' in script-src (CSP Level 3) — a
      // capability the app-wide CSP deliberately doesn't grant. The pure-JS
      // regex engine needs no eval-gated CSP capability at all.
      engine: createJavaScriptRegexEngine(),
    }).catch((err) => {
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
}

const loadedLanguages = new Set<string>(['sudolang']);

async function ensureLanguage(
  highlighter: Highlighter,
  language: string
): Promise<string> {
  if (language === 'sudolang' || loadedLanguages.has(language)) {
    return language;
  }
  try {
    await highlighter.loadLanguage(language as BundledLanguage);
    loadedLanguages.add(language);
    return language;
  } catch {
    return 'text';
  }
}

export async function tokenizeCode(
  code: string,
  language: string,
  theme: ShikiTheme
): Promise<ThemedToken[][]> {
  if (!code) return [];

  const highlighter = await getHighlighter();
  const resolvedLang = await ensureLanguage(highlighter, language);

  return highlighter.codeToTokens(code, {
    lang: resolvedLang as BundledLanguage,
    theme: theme as BundledTheme,
  }).tokens;
}

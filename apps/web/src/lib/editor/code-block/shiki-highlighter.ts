import {
  createHighlighter,
  type Highlighter,
  type ThemedToken,
  type BundledLanguage,
  type BundledTheme,
} from 'shiki';
import { sudolangGrammar } from './sudolang-grammar';

export type ShikiTheme = 'one-light' | 'one-dark-pro';

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['one-light', 'one-dark-pro'],
      langs: [sudolangGrammar],
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

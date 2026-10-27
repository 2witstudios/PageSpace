import type { Monaco } from '@monaco-editor/react';

export const SUDOLANG_LANGUAGE_ID = 'sudolang';

const registeredMonacoInstances = new WeakSet<Monaco>();

const SUDOLANG_TOKENIZER: Parameters<Monaco['languages']['setMonarchTokensProvider']>[1] = {
  defaultToken: '',
  tokenizer: {
    root: [
      [/^#{1,6}\s+.*$/, 'keyword'],
      [/^(\s*)(\/[a-zA-Z][a-zA-Z0-9-]*)/, ['white', 'tag']],
      [/[A-Z][a-zA-Z0-9]*(?=\s*\{)/, 'type.identifier'],
      [/[a-z][a-zA-Z0-9]*(?=\s*\()/, 'function'],
      [/\b(?:Constraints|Options|State|Commands)\b/, 'keyword.control'],
      [/\b(?:fn|type|return|if|else|import|from|infer)\b/, 'keyword'],
      [/\b(?:true|false|null|undefined)\b/, 'constant.language'],
      [/\b\d+(?:\.\d+)?\b/, 'number'],
      [/\|>/, 'keyword.operator'],
      [/=>/, 'keyword.operator'],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],
      [/"/, 'string', '@stringDouble'],
      [/'/, 'string', '@stringSingle'],
    ],
    comment: [
      [/[^\/*]+/, 'comment'],
      [/\/\*/, 'comment', '@push'],
      [/\*\//, 'comment', '@pop'],
      [/[\/*]/, 'comment'],
    ],
    stringDouble: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
    stringSingle: [
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, 'string', '@pop'],
    ],
  },
};

export function registerSudolangLanguage(monaco: Monaco): void {
  if (registeredMonacoInstances.has(monaco)) {
    return;
  }

  const isLanguageRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === SUDOLANG_LANGUAGE_ID);

  if (!isLanguageRegistered) {
    monaco.languages.register({
      id: SUDOLANG_LANGUAGE_ID,
      aliases: ['SudoLang', 'sudolang'],
      extensions: ['.sudo', '.sudolang'],
    });
  }

  monaco.languages.setLanguageConfiguration(SUDOLANG_LANGUAGE_ID, {
    comments: {
      lineComment: '//',
      blockComment: ['/*', '*/'],
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider(SUDOLANG_LANGUAGE_ID, SUDOLANG_TOKENIZER);
  registeredMonacoInstances.add(monaco);
}

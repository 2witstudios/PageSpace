import type { LanguageRegistration } from 'shiki';

export const sudolangGrammar: LanguageRegistration = {
  name: 'sudolang',
  scopeName: 'source.sudolang',
  patterns: [
    { include: '#comment-line' },
    { include: '#comment-block' },
    { include: '#string-double' },
    { include: '#string-single' },
    { include: '#heading' },
    { include: '#slash-command' },
    { include: '#constant-language' },
    { include: '#constant-numeric' },
    { include: '#pipe-operator' },
    { include: '#arrow-operator' },
    { include: '#constraint-keyword' },
    { include: '#keyword' },
    { include: '#type-definition' },
    { include: '#function-definition' },
  ],
  repository: {
    'comment-line': {
      match: '//.*$',
      name: 'comment.line.double-slash.sudolang',
    },
    'comment-block': {
      begin: '/\\*',
      end: '\\*/',
      name: 'comment.block.sudolang',
    },
    'string-double': {
      begin: '"',
      end: '"',
      name: 'string.quoted.double.sudolang',
      patterns: [
        {
          match: '\\\\.',
          name: 'constant.character.escape.sudolang',
        },
      ],
    },
    'string-single': {
      begin: "'",
      end: "'",
      name: 'string.quoted.single.sudolang',
      patterns: [
        {
          match: '\\\\.',
          name: 'constant.character.escape.sudolang',
        },
      ],
    },
    heading: {
      match: '^#{1,6}\\s+.*$',
      name: 'markup.heading.sudolang',
    },
    'slash-command': {
      match: '^\\/[a-zA-Z][a-zA-Z0-9-]*',
      name: 'entity.name.tag.sudolang',
    },
    'constant-language': {
      match: '\\b(true|false|null|undefined)\\b',
      name: 'constant.language.sudolang',
    },
    'constant-numeric': {
      match: '\\b\\d+(\\.\\d+)?\\b',
      name: 'constant.numeric.sudolang',
    },
    'pipe-operator': {
      match: '\\|>',
      name: 'keyword.operator.pipe.sudolang',
    },
    'arrow-operator': {
      match: '=>',
      name: 'keyword.operator.arrow.sudolang',
    },
    'constraint-keyword': {
      match: '\\b(Constraints|Options|State|Commands)\\b',
      name: 'keyword.control.sudolang',
    },
    keyword: {
      match: '\\b(fn|type|return|if|else|import|from|infer)\\b',
      name: 'keyword.other.sudolang',
    },
    'type-definition': {
      match: '\\b([A-Z][a-zA-Z0-9]*)\\s*\\{',
      captures: {
        '1': { name: 'entity.name.type.sudolang' },
      },
    },
    'function-definition': {
      match: '\\b([a-z][a-zA-Z0-9]*)\\s*\\(',
      captures: {
        '1': { name: 'entity.name.function.sudolang' },
      },
    },
  },
};
